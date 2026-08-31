/**
 * Descriptor issuance and verification, and the pieces of the runtime domain that several packages
 * share.
 *
 * The signing material now comes from a configured key ring rather than a keypair generated when the
 * process started, so a descriptor issued by one replica verifies on another and survives a restart.
 */
import { randomUUID } from "node:crypto";
import type { KeyLike } from "jose";
import { descriptorSchema } from "../../contracts/src/index.js";
import { SigningKeyRing } from "./services/signing-keys.js";

export { SigningKeyRing } from "./services/signing-keys.js";
export type { RingKey } from "./services/signing-keys.js";
export { transition, isLegalTransition, OPEN_STATUSES, TERMINAL_STATUSES } from "./store/transitions.js";
export type {
  Assignment, Attempt, AttemptStatus, LaunchRecord, OutboxRow, OutboxStatus, RuntimeStore, SmartLink,
} from "./store/types.js";
export { createStore, resetStore, store, useStore, closeStore, MemoryRuntimeStore, PostgresRuntimeStore } from "./store/index.js";

export interface DescriptorConfig {
  issuer: string;
  evidenceEndpoint: string;
  tenantId?: string;
  playerRef?: string;
  ttlSeconds?: number;
}

/** Descriptor lifetime is measured in minutes by design: a long-lived launch URL is a standing grant. */
export const DEFAULT_DESCRIPTOR_TTL_SECONDS = 600;

export function descriptorTtlSeconds(): number {
  const raw = Number.parseInt(process.env.DESCRIPTOR_TTL_SECONDS ?? "", 10);
  return Number.isInteger(raw) && raw >= 60 && raw <= 900 ? raw : DEFAULT_DESCRIPTOR_TTL_SECONDS;
}

/**
 * When the attempt this descriptor opens stops being usable.
 *
 * It has to be the same lifetime as the descriptor itself. Reporting a fixed ten minutes while
 * `DESCRIPTOR_TTL_SECONDS` said something else told the player its session was still valid after
 * authentication had already started failing — or, with a longer configured lifetime, let attempt
 * maintenance expire a session whose descriptor a learner was still holding. One value, derived
 * once, used by every launch path.
 */
export function sessionExpiresAt(now: Date = new Date()): string {
  return new Date(now.getTime() + descriptorTtlSeconds() * 1000).toISOString();
}

export function defaultTenantId(): string {
  return process.env.LORB_TENANT_ID ?? "lorb-default";
}

export function defaultPlayerRef(): string {
  return process.env.PLAYER_REF ?? "lorb-shell-v1";
}

export async function issueDescriptor(
  ring: SigningKeyRing,
  claims: Record<string, unknown>,
  config: DescriptorConfig,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = config.ttlSeconds ?? descriptorTtlSeconds();
  const payload = {
    ...claims,
    iss: config.issuer,
    aud: "lorb-player",
    iat: now,
    nbf: now,
    exp: now + ttl,
    jti: randomUUID(),
    tenant_id: config.tenantId ?? defaultTenantId(),
    delivery_profile: "native-web-package",
    launch_mode: "embedded-iframe",
    player_ref: config.playerRef ?? defaultPlayerRef(),
    evidence_endpoint: config.evidenceEndpoint,
    telemetry_config: { correlation_header: "X-Correlation-ID" },
    contract_version: "1.0",
  };
  descriptorSchema.parse(payload);
  return ring.sign(payload, { typ: "lorb-launch+jwt", cty: "application/lorb-launch+json", lorb_schema: "1.0" });
}

export async function verifyDescriptor(token: string, ring: SigningKeyRing, issuer: string) {
  const { payload } = await ring.verify(token, { issuer, audience: "lorb-player" });
  return descriptorSchema.parse(payload);
}

/**
 * What an LTI tool's OIDC login step gets as `login_hint`, in place of the launch descriptor itself.
 *
 * The descriptor is a live bearer credential — Player Shell sends it as `Authorization: Bearer` on
 * every state/evidence call — so handing it to a third-party tool via a URL query parameter would
 * leak a working credential through the Referer header, the tool's own logs, and browser history.
 * This token instead carries only what `/api/v1/lti/authorize` needs to resolve the launch: who is
 * launching, which object, and which attempt. It is minted fresh for the LTI hand-off, signed by a
 * ring dedicated to that purpose, and short-lived enough that a leaked copy is worth little.
 */
export interface LtiLoginHintClaims {
  sub: string;
  object_id: string;
  attempt_id: string;
}

const LTI_LOGIN_HINT_TTL_SECONDS = 300;
const LTI_LOGIN_HINT_AUDIENCE = "lorb-lti-login-hint";

export async function signLtiLoginHint(ring: SigningKeyRing, claims: LtiLoginHintClaims, issuer: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...claims,
    iss: issuer,
    aud: LTI_LOGIN_HINT_AUDIENCE,
    iat: now,
    nbf: now,
    exp: now + LTI_LOGIN_HINT_TTL_SECONDS,
    jti: randomUUID(),
  };
  return ring.sign(payload, { typ: "lorb-lti-login-hint+jwt" });
}

export async function verifyLtiLoginHint(token: string, ring: SigningKeyRing, issuer: string): Promise<LtiLoginHintClaims> {
  const { payload } = await ring.verify(token, { issuer, audience: LTI_LOGIN_HINT_AUDIENCE });
  const { sub, object_id, attempt_id } = payload as Record<string, unknown>;
  if (typeof sub !== "string" || typeof object_id !== "string" || typeof attempt_id !== "string") {
    throw new Error("malformed LTI login hint");
  }
  return { sub, object_id, attempt_id };
}

/**
 * Two of the enforced anti-requirements, in one function: a postMessage origin is never a wildcard,
 * and never an origin outside the configured allow-list. The source-window and module-origin checks
 * bind the message to the iframe the shell actually created.
 */
export function originAllowed(origin: string, configured: string, moduleOrigin: string, source: unknown, iframeWindow: unknown): boolean {
  return origin !== "*" && configured.split(",").includes(origin) && origin === moduleOrigin && source === iframeWindow;
}

/** Convenience for callers that hold a raw private key rather than a ring (test harnesses). */
export type { KeyLike };
