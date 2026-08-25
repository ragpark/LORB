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
 * Two of the enforced anti-requirements, in one function: a postMessage origin is never a wildcard,
 * and never an origin outside the configured allow-list. The source-window and module-origin checks
 * bind the message to the iframe the shell actually created.
 */
export function originAllowed(origin: string, configured: string, moduleOrigin: string, source: unknown, iframeWindow: unknown): boolean {
  return origin !== "*" && configured.split(",").includes(origin) && origin === moduleOrigin && source === iframeWindow;
}

/** Convenience for callers that hold a raw private key rather than a ring (test harnesses). */
export type { KeyLike };
