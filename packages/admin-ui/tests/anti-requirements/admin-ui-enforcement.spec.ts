// See README-anti-requirements.md in this directory for the specification cross-reference (Section 13).
// Items enforced primarily server-side (RBAC/ABAC denial, immutability, idempotency, audit
// transactionality, the Postgres self-approval CHECK, and the launch-policy resolver) have their
// authoritative test in tests/runtime-api/admin-enforcement.spec.ts at the repo root — this file
// verifies what the Admin UI itself is responsible for: not rendering forbidden content, disabling
// the right controls, and never routing secrets into logs or storage.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allowsDevelopmentSignIn, environmentNotice } from '@lorb/web-auth';

const srcDir = new URL('../../src/', import.meta.url).pathname;
function readSrc(relativePath: string): string {
  return readFileSync(join(srcDir, relativePath), 'utf8');
}
function allSourceFiles(dir = srcDir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? allSourceFiles(full + '/') : [full];
  });
}
const app = readSrc('App.tsx');
const auth = readSrc('lib/auth.ts');
const apiClient = readSrc('lib/api-client.ts');
const redaction = readSrc('lib/redaction.ts');
const separationOfDuties = readSrc('lib/separation-of-duties.ts');
const styles = readSrc('styles.css');
const allSourceText = allSourceFiles().map((path) => readFileSync(path, 'utf8')).join('\n');

describe('Administration workspace enforcement controls', () => {
  // A non-production workspace says which one it is before anything a keyboard user can reach, so
  // an administrator knows whether the records in front of them are real before they act on them.
  // Production shows no banner: one that is always there stops being read.
  it('1 renders the environment notice before the first interactive element', () => {
    expect(app.indexOf('environment-notice')).toBeLessThan(app.indexOf('className="skip"'));
  });

  it('2 accepts only the known environment labels and fails startup otherwise', () => {
    expect(app).toContain('ENVIRONMENT_LABELS.includes');
    expect(app).toContain('Environment configuration error');
  });

  // A deployed build with no identity provider must refuse to open, not render a workspace whose
  // every request fails with a 401 the administrator cannot act on.
  it('2b refuses a non-development build without an identity provider', () => {
    expect(app).toContain('!allowsDevelopmentSignIn(ENVIRONMENT as never) && !adminOidcClient()');
    expect(app).toContain('requires an identity provider');
  });

  it('2a shows no environment notice in production', () => {
    expect(environmentNotice('PRODUCTION')).toBeUndefined();
    expect(environmentNotice('STAGING')).toBeTruthy();
  });

  // A deployed workspace that could obtain an administrator token by POSTing a chosen subject string
  // to a login endpoint would have no authentication at all. The development path is gated on the
  // environment label rather than a build flag, because a build flag gets flipped and left.
  it('2b confines the local sign-in to a development environment', () => {
    expect(auth).toContain('allowsDevelopmentSignIn');
    expect(allowsDevelopmentSignIn('PRODUCTION')).toBe(false);
    expect(allowsDevelopmentSignIn('DEVELOPMENT')).toBe(true);
  });

  it('2c prefers the configured identity provider wherever one exists', () => {
    expect(app).toContain('adminOidcClient()');
    expect(app).toContain("organisation&rsquo;s identity provider");
  });

  it('3 never mentions ActiveHub or Pearson anywhere in the source that becomes the built bundle', () => {
    expect(allSourceText).not.toMatch(/ActiveHub/i);
    expect(allSourceText).not.toMatch(/Pearson/i);
  });

  it('4 denies non-admin users at every admin route (authoritative test: runtime-api requireAdmin, see tests/runtime-api/admin-enforcement.spec.ts)', () => {
    // The UI never attempts client-side role gating of its own — every admin<T>() call goes through
    // adminApiRequest, which always attaches the caller's token and lets the server be the sole
    // decision-maker (deny-by-default, Section 6.3). Confirm there is no local bypass path.
    expect(app).not.toMatch(/role\s*===\s*['"]admin['"]\s*\?/);
    expect(apiClient).not.toContain('role');
  });

  it('5 denies unauthenticated requests at every admin route (authoritative test: runtime-api requireAdmin)', () => {
    expect(apiClient).toContain('session.getToken()');
  });

  it('6 denies requests without the correct repository membership (authoritative test: runtime-api requireRepositoryMembership)', () => {
    expect(readFileSync(new URL('../../../runtime-api/src/services/admin-authz.ts', import.meta.url).pathname, 'utf8')).toContain('MEMBERSHIP_NOT_PERMITTED');
  });

  it('7 attaches Idempotency-Key to every state-changing admin request', () => {
    expect(apiClient).toContain("headers['Idempotency-Key']");
    expect(apiClient).toContain("method !== 'GET'");
  });

  it('8 writes an audit record in the same transaction as every mutation (authoritative test: runtime-api withAdminTransaction usage)', () => {
    const sharedTs = readFileSync(new URL('../../../runtime-api/src/routes/admin/shared.ts', import.meta.url).pathname, 'utf8');
    expect(sharedTs).toContain('withAdminTransaction');
    expect(sharedTs).toContain('writeAudit');
  });

  it("9 writes a DENIED audit record for denied attempts (authoritative test: runtime-api requireAdmin/requireAuthorised)", () => {
    const sharedTs = readFileSync(new URL('../../../runtime-api/src/routes/admin/shared.ts', import.meta.url).pathname, 'utf8');
    expect(sharedTs).toContain('outcome: "DENIED"');
  });

  it('10 rejects audit_record UPDATE and DELETE at the Postgres trigger (authoritative test: tests/runtime-api/admin-enforcement.spec.ts)', () => {
    const migration = readFileSync(new URL('../../../runtime-api/src/db/migrations/003_admin_tables.sql', import.meta.url).pathname, 'utf8');
    expect(migration).toContain('audit_record_no_update');
    expect(migration).toContain('audit_record_no_delete');
  });

  it('11 blocks mutation of immutable player_version fields once approved or beyond (authoritative test: Postgres trigger + tests/runtime-api/admin-enforcement.spec.ts)', () => {
    const migration = readFileSync(new URL('../../../runtime-api/src/db/migrations/003_admin_tables.sql', import.meta.url).pathname, 'utf8');
    expect(migration).toContain('PLAYER_VERSION_IMMUTABLE');
  });

  it('12 blocks mutation of immutable launch_policy_version fields once published or beyond (authoritative test: Postgres trigger)', () => {
    const migration = readFileSync(new URL('../../../runtime-api/src/db/migrations/003_admin_tables.sql', import.meta.url).pathname, 'utf8');
    expect(migration).toContain('LAUNCH_POLICY_VERSION_IMMUTABLE');
  });

  it('13 rejects player version registration with an integrity algorithm weaker than sha384 (authoritative test: runtime-api players route)', () => {
    const playersRoute = readFileSync(new URL('../../../runtime-api/src/routes/admin/players.ts', import.meta.url).pathname, 'utf8');
    expect(playersRoute).toContain('PLAYER_INTEGRITY_WEAK');
    expect(playersRoute).toContain("WEAK_ALGORITHMS = new Set(['sha256'])".replace(/'/g, '"'));
  });

  it('14 rejects player version registration when module_origin is not allow-listed (authoritative test: runtime-api players route)', () => {
    const playersRoute = readFileSync(new URL('../../../runtime-api/src/routes/admin/players.ts', import.meta.url).pathname, 'utf8');
    expect(playersRoute).toContain('PLAYER_ORIGIN_NOT_ALLOWED');
    expect(playersRoute).toContain('playerModuleOriginAllowlist');
  });

  it('15 disables the direct approve/reject action for the requesting principal in the UI (layer 1 of Section 12)', () => {
    expect(app).toContain('disabled={self}');
    expect(app).toContain('isSelfApproval');
    expect(separationOfDuties).toContain('currentPrincipalPseudonym === requestedByPseudonym');
  });

  it('16 rejects execution of an approval that is not APPROVED (authoritative test: runtime-api approval-service)', () => {
    const approvalService = readFileSync(new URL('../../../runtime-api/src/services/approval-service.ts', import.meta.url).pathname, 'utf8');
    expect(approvalService).toContain('APPROVAL_REQUIRED');
  });

  it('17 never renders a raw IES subject; the header identifies the operator by pseudonym only', () => {
    expect(app).toContain('whoami.data?.pseudonym');
    expect(app).not.toContain('getIdentityLabel');
    expect(auth).not.toContain('localStorage');
  });

  it('18 stores the session token only in sessionStorage, never localStorage', () => {
    expect(auth).toContain('sessionStorage');
    expect(auth).not.toContain('localStorage');
  });

  it('19 never uses dangerouslySetInnerHTML anywhere in the UI codebase', () => {
    expect(allSourceText).not.toContain(['dangerously', 'SetInnerHTML'].join(''));
  });

  it('20 never configures or documents a wildcard CORS origin', () => {
    expect(allSourceText).not.toContain('Access-Control-Allow-Origin: *');
    expect(allSourceText).not.toMatch(/origin:\s*true/);
  });

  it('21 redacts Authorization before anything reaches the Diagnostics log, and forbids raw subjects/secrets/tokens/descriptors from any logged state', () => {
    expect(apiClient).toContain('redactHeaders(headers)');
    expect(redaction).toMatch(/subject/);
    expect(redaction).toMatch(/tenant_secret/);
    expect(redaction).toMatch(/private_key/);
    expect(redaction).toMatch(/signed_descriptor/);
    expect(redaction).toMatch(/bearer/i);
  });

  it('22 does not use blue-and-white Pearson-style palettes', () => {
    for (const banned of ['#0d47a1', '#1565c0', '#1976d2', '#2196f3', '#003057']) {
      expect(styles.toLowerCase()).not.toContain(banned);
    }
    expect(allSourceText).not.toMatch(/\bblue-\d{2,3}\b/);
  });

  it('23 offers no route or component that corrects an accepted xAPI statement', () => {
    expect(allSourceText).not.toMatch(/evidence.?correction/i);
    expect(allSourceText).not.toMatch(/correct.?statement/i);
  });

  it('24 the launch resolver prefers the active launch_policy_version and falls back to the default resolver when unmatched (authoritative test: tests/runtime-api/admin-enforcement.spec.ts)', () => {
    const resolver = readFileSync(new URL('../../../runtime-api/src/services/launch-policy-resolver.ts', import.meta.url).pathname, 'utf8');
    expect(resolver).toContain("if (!process.env.DATABASE_URL) return null");
    expect(resolver).toContain('ruleMatches');
  });

  it('25 shows the Simulate action on launch policy versions, disabled, with a Deferred to Wave 2 tooltip', () => {
    expect(app).toContain('<button disabled>Simulate</button>');
    expect(app).toContain('Deferred to Wave 2');
  });
});
