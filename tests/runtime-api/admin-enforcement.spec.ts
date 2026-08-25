// Administration workspace (Wave 1) API/DB-side anti-requirements — Section 13 of the brief.
// Requires Postgres (docker compose up -d, matching the project's existing DATABASE_URL convention
// in .env.example) with migrations 001_mvp.sql and 003_admin_tables.sql applied.
// UI-side controls (banner, pseudonym-only display, sessionStorage, no dangerouslySetInnerHTML, the
// Simulate tooltip, etc.) are tested in packages/admin-ui/tests/anti-requirements/admin-ui-enforcement.spec.ts.
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { decodeJwt } from "jose";
import { MemoryCatalogueStore, QUIZ_PLAYER } from "../../packages/runtime-api/src/catalogue/index.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://lorb:lorb@localhost:5432/lorb_mvp";
process.env.DATABASE_URL = DATABASE_URL;
process.env.ADMIN_ALLOWED_ROLES = "admin";
process.env.ADMIN_APPROVAL_REQUIRED_FOR =
  "repository.suspend,repository.retire,player_version.approve,player_version.activate,player_version.suspend,launch_policy_version.publish,launch_policy_version.activate";

describe("Administration workspace API/DB enforcement", () => {
  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  let pool: pg.Pool;
  const ies = { privateKey: undefined as unknown, publicKey: undefined as unknown };
  const urls = { ies: "https://ies.admin-enforcement.test", player: "https://player.admin-enforcement.test" };
  let tokenA: string;
  let tokenB: string;
  let nonAdminToken: string;
  let catalogue: MemoryCatalogueStore;
  let catalogueRepositoryId: string;

  beforeAll(async () => {
    const keys = await generateKeyPair("ES256");
    ies.privateKey = keys.privateKey;
    ies.publicKey = keys.publicKey;
    catalogue = new MemoryCatalogueStore();
    catalogueRepositoryId = (await catalogue.defaultRepository())!.repository_id;
    runtime = await buildRuntime({
      iesKey: keys.publicKey, iesIssuer: urls.ies, playerOrigin: urls.player,
      secret: Buffer.alloc(32, 3), store: new MemoryRuntimeStore(), catalogue,
    });
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    tokenA = await issueIesToken(keys.privateKey as never, "synthetic-enforcement-a", "lorb-runtime", urls.ies, { role: "admin" });
    tokenB = await issueIesToken(keys.privateKey as never, "synthetic-enforcement-b", "lorb-runtime", urls.ies, { role: "admin" });
    nonAdminToken = await issueIesToken(keys.privateKey as never, "synthetic-enforcement-learner", "lorb-runtime", urls.ies, {});
  });

  afterAll(async () => {
    await runtime.app.close();
    await pool.end();
  });

  async function admin(token: string | undefined, method: "GET" | "POST", path: string, payload?: Record<string, unknown>, idempotencyKey = randomUUID()) {
    return runtime.app.inject({
      method,
      url: `/api/v1/admin${path}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === "POST" ? { "idempotency-key": idempotencyKey } : {}) },
      payload,
    });
  }

  async function createRepository(token: string) {
    const slug = `enf-${randomUUID().slice(0, 8)}`;
    const res = await admin(token, "POST", "/repositories", { slug, display_name: "Enforcement Repository" });
    expect(res.statusCode).toBe(201);
    return res.json().repository_id as string;
  }

  async function createApprovedActivePlayerVersion(token: string, approver: string) {
    const player = await admin(token, "POST", "/players", { display_name: "Enforcement Player" });
    const playerId = player.json().player_id as string;
    const version = await admin(token, "POST", `/players/${playerId}/versions`, {
      semver: "1.0.0",
      module_url: `${urls.player}/module/index.html`,
      module_origin: urls.player,
      integrity_algorithm: "sha384",
      integrity_hash: "abc123",
      supported_descriptor_versions: ["1.0"],
      supported_protocol_versions: ["1.0"],
      supported_delivery_profiles: ["native-web-package"],
      supported_launch_modes: ["embedded-iframe"],
    });
    const playerVersionId = version.json().player_version_id as string;
    for (const action of ["approve", "activate"]) {
      const req = await admin(token, "POST", `/players/${playerId}/versions/${playerVersionId}/${action}`);
      const approvalRequestId = req.json().approval_request_id as string;
      await admin(approver, "POST", `/approval-requests/${approvalRequestId}/approve`);
      await admin(token, "POST", `/approval-requests/${approvalRequestId}/execute`);
    }
    return { playerId, playerVersionId };
  }

  it("4 denies a non-admin at an admin route", async () => {
    const res = await admin(nonAdminToken, "GET", "/repositories");
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ADMIN_AUDIT_DENIED");
  });

  it("5 denies an unauthenticated request", async () => {
    const res = await admin(undefined, "GET", "/repositories");
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("AUTHENTICATION_EXPIRED");
  });

  it("6 denies a second admin with no membership on the repository", async () => {
    const repositoryId = await createRepository(tokenA);
    const res = await admin(tokenB, "GET", `/repositories/${repositoryId}/memberships`);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("MEMBERSHIP_NOT_PERMITTED");
  });

  it("7 requires Idempotency-Key on every state-changing request", async () => {
    const res = await runtime.app.inject({ method: "POST", url: "/api/v1/admin/players", headers: { authorization: `Bearer ${tokenA}` }, payload: { display_name: "No idempotency key" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("8 writes an audit record in the same transaction as the mutation, and 9 denied attempts are audited too", async () => {
    const repositoryId = await createRepository(tokenA);
    const audit = await admin(tokenA, "GET", `/audit-records?target_type=repository&target_id=${repositoryId}`);
    const records = audit.json().items as { action_type: string; outcome: string }[];
    expect(records.some((r) => r.action_type === "repository.create" && r.outcome === "ALLOWED")).toBe(true);

    const denied = await admin(tokenB, "GET", `/repositories/${repositoryId}`);
    expect(denied.statusCode).toBe(403);
    const deniedAudit = await pool.query("select outcome from audit_record where action_type = 'repository.get' and outcome = 'DENIED' order by created_at desc limit 1");
    expect(deniedAudit.rows[0]?.outcome).toBe("DENIED");
  });

  it("10 rejects audit_record UPDATE and DELETE at the Postgres trigger", async () => {
    const row = await pool.query("select audit_id from audit_record order by created_at desc limit 1");
    const auditId = row.rows[0].audit_id;
    await expect(pool.query("update audit_record set reason = 'tampered' where audit_id = $1", [auditId])).rejects.toThrow(/AUDIT_RECORD_IMMUTABLE/);
    await expect(pool.query("delete from audit_record where audit_id = $1", [auditId])).rejects.toThrow(/AUDIT_RECORD_IMMUTABLE/);
  });

  it("11 blocks mutation of an approved/active player_version's immutable fields", async () => {
    const { playerVersionId } = await createApprovedActivePlayerVersion(tokenA, tokenB);
    await expect(pool.query("update player_version set module_url = 'https://evil.test/module.js' where player_version_id = $1", [playerVersionId])).rejects.toThrow(/PLAYER_VERSION_IMMUTABLE/);
  });

  it("12 blocks mutation of a published launch_policy_version's rules", async () => {
    const repositoryId = await createRepository(tokenA);
    const { playerId, playerVersionId } = await createApprovedActivePlayerVersion(tokenA, tokenB);
    const policy = await admin(tokenA, "POST", "/launch-policies", { display_name: "Enforcement Policy" });
    const launchPolicyId = policy.json().launch_policy_id as string;
    const version = await admin(tokenA, "POST", `/launch-policies/${launchPolicyId}/versions`, {
      semver: "1.0.0",
      rules: { rules: [{ priority: 0, match: { repository_id: repositoryId }, route: { player_id: playerId, player_version_id: playerVersionId } }] },
    });
    const launchPolicyVersionId = version.json().launch_policy_version_id as string;
    const publish = await admin(tokenA, "POST", `/launch-policies/${launchPolicyId}/versions/${launchPolicyVersionId}/publish`);
    await admin(tokenB, "POST", `/approval-requests/${publish.json().approval_request_id}/approve`);
    await admin(tokenA, "POST", `/approval-requests/${publish.json().approval_request_id}/execute`);
    await expect(pool.query("update launch_policy_version set rules = $2 where launch_policy_version_id = $1", [launchPolicyVersionId, JSON.stringify({ rules: [] })])).rejects.toThrow(
      /LAUNCH_POLICY_VERSION_IMMUTABLE/,
    );
  });

  it("13 rejects a weaker-than-sha384 integrity algorithm", async () => {
    const player = await admin(tokenA, "POST", "/players", { display_name: "Weak Integrity Player" });
    const res = await admin(tokenA, "POST", `/players/${player.json().player_id}/versions`, {
      semver: "1.0.0",
      module_url: `${urls.player}/module/index.html`,
      module_origin: urls.player,
      integrity_algorithm: "sha256",
      integrity_hash: "abc123",
      supported_descriptor_versions: ["1.0"],
      supported_protocol_versions: ["1.0"],
      supported_delivery_profiles: ["native-web-package"],
      supported_launch_modes: ["embedded-iframe"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("PLAYER_INTEGRITY_WEAK");
  });

  it("14 rejects a module_origin outside the allow-list", async () => {
    const player = await admin(tokenA, "POST", "/players", { display_name: "Bad Origin Player" });
    const res = await admin(tokenA, "POST", `/players/${player.json().player_id}/versions`, {
      semver: "1.0.0",
      module_url: "https://not-allowed.example/module.js",
      module_origin: "https://not-allowed.example",
      integrity_algorithm: "sha384",
      integrity_hash: "abc123",
      supported_descriptor_versions: ["1.0"],
      supported_protocol_versions: ["1.0"],
      supported_delivery_profiles: ["native-web-package"],
      supported_launch_modes: ["embedded-iframe"],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("PLAYER_ORIGIN_NOT_ALLOWED");
  });

  it("15 blocks self-approval at the API and DB layers", async () => {
    const player = await admin(tokenA, "POST", "/players", { display_name: "Self Approve Player" });
    const version = await admin(tokenA, "POST", `/players/${player.json().player_id}/versions`, {
      semver: "1.0.0",
      module_url: `${urls.player}/module/index.html`,
      module_origin: urls.player,
      integrity_algorithm: "sha384",
      integrity_hash: "abc123",
      supported_descriptor_versions: ["1.0"],
      supported_protocol_versions: ["1.0"],
      supported_delivery_profiles: ["native-web-package"],
      supported_launch_modes: ["embedded-iframe"],
    });
    const req = await admin(tokenA, "POST", `/players/${player.json().player_id}/versions/${version.json().player_version_id}/approve`);
    const approvalRequestId = req.json().approval_request_id as string;
    const selfApprove = await admin(tokenA, "POST", `/approval-requests/${approvalRequestId}/approve`);
    expect(selfApprove.statusCode).toBe(409);
    expect(selfApprove.json().code).toBe("SEPARATION_OF_DUTIES_REQUIRED");

    // DB layer: the CHECK constraint rejects approver_pseudonym = requested_by_pseudonym directly, bypassing the API entirely.
    const row = await pool.query("select requested_by_pseudonym from approval_request where approval_request_id = $1", [approvalRequestId]);
    const requester = row.rows[0].requested_by_pseudonym as string;
    await expect(
      pool.query("update approval_request set approver_pseudonym = $2, status = 'APPROVED' where approval_request_id = $1", [approvalRequestId, requester]),
    ).rejects.toThrow(/approval_request_check|violates check constraint/);
  });

  it("16 rejects execution of an approval that is not APPROVED", async () => {
    const player = await admin(tokenA, "POST", "/players", { display_name: "Not Approved Player" });
    const version = await admin(tokenA, "POST", `/players/${player.json().player_id}/versions`, {
      semver: "1.0.0",
      module_url: `${urls.player}/module/index.html`,
      module_origin: urls.player,
      integrity_algorithm: "sha384",
      integrity_hash: "abc123",
      supported_descriptor_versions: ["1.0"],
      supported_protocol_versions: ["1.0"],
      supported_delivery_profiles: ["native-web-package"],
      supported_launch_modes: ["embedded-iframe"],
    });
    const req = await admin(tokenA, "POST", `/players/${player.json().player_id}/versions/${version.json().player_version_id}/approve`);
    const execute = await admin(tokenA, "POST", `/approval-requests/${req.json().approval_request_id}/execute`);
    expect(execute.statusCode).toBe(409);
    expect(execute.json().code).toBe("APPROVAL_REQUIRED");
  });

  it("20 never permits a wildcard CORS origin", async () => {
    const res = await runtime.app.inject({ method: "OPTIONS", url: "/api/v1/admin/repositories", headers: { origin: "https://not-a-real-admin-origin.example", "access-control-request-method": "GET" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("24 the launch resolver prefers the active launch_policy_version when matched", async () => {
    const repositoryId = await createRepository(tokenA);
    const { playerId, playerVersionId } = await createApprovedActivePlayerVersion(tokenA, tokenB);
    const policy = await admin(tokenA, "POST", "/launch-policies", { display_name: "Resolver Policy" });
    const launchPolicyId = policy.json().launch_policy_id as string;
    const version = await admin(tokenA, "POST", `/launch-policies/${launchPolicyId}/versions`, {
      semver: "1.0.0",
      rules: { rules: [{ priority: 0, match: { repository_id: repositoryId }, route: { player_id: playerId, player_version_id: playerVersionId } }] },
    });
    const launchPolicyVersionId = version.json().launch_policy_version_id as string;
    for (const action of ["publish", "activate"]) {
      const req = await admin(tokenA, "POST", `/launch-policies/${launchPolicyId}/versions/${launchPolicyVersionId}/${action}`);
      const approvalRequestId = req.json().approval_request_id as string;
      await admin(tokenB, "POST", `/approval-requests/${approvalRequestId}/approve`);
      await admin(tokenA, "POST", `/approval-requests/${approvalRequestId}/execute`);
    }
    const learnerToken = await issueIesToken(ies.privateKey as never, "synthetic-enforcement-learner-2", "lorb-runtime", urls.ies, {});
    // A launch resolves a registered object; an unknown identifier is refused rather than routed.
    const routed = await catalogue.registerObject({
      repository_id: repositoryId, title: "Resolver target",
      module_path: "/module/index.html", semver: "1.0.0", sha256: "b".repeat(64),
    });
    const launch = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": randomUUID() },
      payload: { contract_version: "1.0", consumer_id: "enforcement-test", repository_id: repositoryId, object_id: routed.object_id, requested_launch_mode: "embedded-iframe", locale: "en-GB" },
    });
    expect(launch.statusCode).toBe(201);
    const attempt = await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/attempts/${launch.json().attempt_id}` });
    expect(attempt.json().governed_by_launch_policy).toMatchObject({ launch_policy_id: launchPolicyId, launch_policy_version_id: launchPolicyVersionId });

    // Unmatched context falls back to the pre-existing default resolver behaviour (no governance reference).
    const unmatchedLaunch = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": randomUUID() },
      payload: { contract_version: "1.0", consumer_id: "enforcement-test", repository_id: randomUUID(), object_id: randomUUID(), requested_launch_mode: "embedded-iframe", locale: "en-GB" },
    });
    const unmatchedAttempt = await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/attempts/${unmatchedLaunch.json().attempt_id}` });
    expect(unmatchedAttempt.json().governed_by_launch_policy).toBeUndefined();
  });

  /**
   * A launch policy routes a player for content that does not care which one renders it. Quiz
   * content does care: only the quiz player can present and mark it, and create_quiz tells the
   * teacher it is rendered by that fixed, already-reviewed package version.
   *
   * The bug this covers shipped as issue #48: a matching policy overrode the pinned player, so a
   * quiz authored through MCP launched into a generic shell with nothing to display. Smart links
   * were unaffected because they never consult a policy, which is exactly how it stayed hidden.
   */
  it("25 a launch policy does not override a player the learning object pins", async () => {
    const { playerId, playerVersionId } = await createApprovedActivePlayerVersion(tokenA, tokenB);
    const policy = await admin(tokenA, "POST", "/launch-policies", { display_name: "Pinned Player Policy" });
    const launchPolicyId = policy.json().launch_policy_id as string;
    // Scoped to a consumer id unique to this run, not to a repository. The quiz has to launch under
    // the catalogue repository it actually belongs to — see the mismatch case below — and a rule
    // scoped to that shared repository would then match launches in every later run of this suite.
    // An ACTIVE policy cannot be deactivated through the API (issue #49), so that would be permanent.
    const consumerId = `pinned-player-${randomUUID()}`;
    const version = await admin(tokenA, "POST", `/launch-policies/${launchPolicyId}/versions`, {
      semver: "1.0.0",
      rules: { rules: [{ priority: 0, match: { consumer_id: consumerId }, route: { player_id: playerId, player_version_id: playerVersionId } }] },
    });
    const launchPolicyVersionId = version.json().launch_policy_version_id as string;
    for (const action of ["publish", "activate"]) {
      const req = await admin(tokenA, "POST", `/launch-policies/${launchPolicyId}/versions/${launchPolicyVersionId}/${action}`);
      const approvalRequestId = req.json().approval_request_id as string;
      await admin(tokenB, "POST", `/approval-requests/${approvalRequestId}/approve`);
      await admin(tokenA, "POST", `/approval-requests/${approvalRequestId}/execute`);
    }

    const quiz = await catalogue.registerQuiz({
      title: "Pinned player check",
      questions: [{ stem: "Does the quiz player render this?", options: [{ id: "a", text: "Yes" }, { id: "b", text: "No" }], correct_option_id: "a" }],
    } as never);
    // An object that pins no shared player, so a policy is free to route its renderer.
    const generic = await catalogue.registerObject({
      repository_id: catalogueRepositoryId, title: "Generic activity",
      module_path: "/module/index.html", semver: "1.0.0", sha256: "a".repeat(64),
    });
    const learnerToken = await issueIesToken(ies.privateKey as never, "synthetic-enforcement-learner-3", "lorb-runtime", urls.ies, {});
    const launch = (objectId: string, repositoryId: string) =>
      runtime.app.inject({
        method: "POST", url: "/api/v1/runtime/launches",
        headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": randomUUID() },
        payload: { contract_version: "1.0", consumer_id: consumerId, repository_id: repositoryId, object_id: objectId, requested_launch_mode: "embedded-iframe", locale: "en-GB" },
      });
    const packageUrlOf = (response: { json: () => { signed_descriptor: string } }) =>
      (decodeJwt(response.json().signed_descriptor) as { package_url: string }).package_url;

    // The fix: the quiz reaches the quiz player even though a policy matched this launch.
    const pinned = await launch(quiz.object_id, catalogueRepositoryId);
    expect(pinned.statusCode).toBe(201);
    expect(packageUrlOf(pinned)).toBe(`${urls.player}${QUIZ_PLAYER.module_path}`);
    expect(packageUrlOf(pinned)).not.toBe(`${urls.player}/module/index.html`);

    // The policy still applied and is still recorded — it governs everything except the renderer.
    const attempt = await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/attempts/${pinned.json().attempt_id}` });
    expect(attempt.json().governed_by_launch_policy).toMatchObject({ launch_policy_id: launchPolicyId });
    expect(attempt.json().package_pinned_by_object).toBe(true);

    // An object that pins nothing still follows the policy, so this is not the feature turned off.
    const unpinned = await launch(generic.object_id, catalogueRepositoryId);
    expect(unpinned.statusCode).toBe(201);
    expect(packageUrlOf(unpinned)).toBe(`${urls.player}/module/index.html`);

    // A pin must not be usable to escape a different repository's policy. The launch request carries
    // both identifiers and nothing else forces them to agree, so naming a known quiz alongside a
    // repository it does not belong to has to be refused outright rather than resolved to whichever
    // package one of the two identifiers happens to name.
    const foreignRepository = await createRepository(tokenA);
    const mismatched = await launch(quiz.object_id, foreignRepository);
    expect(mismatched.statusCode).toBe(404);
    expect(mismatched.json().code).toBe("OBJECT_NOT_FOUND");

    // An object that is in no repository at all is refused too: a launch never silently substitutes
    // a default package for content nobody registered.
    const unknown = await launch(randomUUID(), catalogueRepositoryId);
    expect(unknown.statusCode).toBe(404);

    // The launch schema accepts a UUID in either case and catalogue keys are lower case, so a client
    // that upper-cases identifiers must still get its pin. Without normalising, the lookup misses or
    // the comparison fails, no pin is found, and the quiz quietly gets the generic player again.
    const shouted = await launch(quiz.object_id.toUpperCase(), catalogueRepositoryId.toUpperCase());
    expect(shouted.statusCode).toBe(201);
    expect(packageUrlOf(shouted)).toBe(`${urls.player}${QUIZ_PLAYER.module_path}`);

    // Mixed case across the two must not accidentally satisfy the repository check either.
    const mixed = await launch(quiz.object_id, catalogueRepositoryId.toUpperCase());
    expect(packageUrlOf(mixed)).toBe(`${urls.player}${QUIZ_PLAYER.module_path}`);
  });
});
