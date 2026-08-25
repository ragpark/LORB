// The internal service-to-service trust boundary.
//
// The routes under /api/v1/internal/runtime are distinct from both the consumer surface (provider
// access tokens, audience `lorb-runtime`) and the player surface (Runtime-signed launch descriptors,
// audience `lorb-player`). They exist so one internal caller can record an assignment for a whole
// class from a single request instead of impersonating one login per learner.
//
// The credential is one pre-shared service token per environment, compared in constant time. It
// carries no principal identity, so it authorises the *service*, never a person: every route behind
// it derives the acting teacher from an explicit agent-principal link instead. It must never be
// issued to a browser, and must never be accepted as, or exchanged for, a learner access token or a
// launch descriptor. Rotating it is a deployment-variable change on both sides.
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison over fixed-width digests, so token length is not observable. */
export function credentialMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

export type InternalAuthFailure = { code: "INTERNAL_SERVICE_CREDENTIAL_UNCONFIGURED" | "INTERNAL_SURFACE_NOT_BROWSER_ACCESSIBLE" | "AUTHENTICATION_EXPIRED"; status: number };

/**
 * Fails closed: an unset credential rejects every request rather than allowing them.
 * Also refuses any request carrying an `Origin` header — this surface is server-to-server, so a
 * browser-originated call is always a misconfiguration (and is never CORS-allowed for it either).
 */
export function checkServiceCredential(req: FastifyRequest, configured: string | undefined): InternalAuthFailure | undefined {
  if (typeof req.headers.origin === "string") return { code: "INTERNAL_SURFACE_NOT_BROWSER_ACCESSIBLE", status: 403 };
  if (!configured) return { code: "INTERNAL_SERVICE_CREDENTIAL_UNCONFIGURED", status: 503 };
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return { code: "AUTHENTICATION_EXPIRED", status: 401 };
  const presented = header.slice("Bearer ".length);
  if (!presented || !credentialMatches(presented, configured)) return { code: "AUTHENTICATION_EXPIRED", status: 401 };
  return undefined;
}

export function sendInternalError(reply: FastifyReply, failure: InternalAuthFailure, correlation_id: string) {
  return reply.code(failure.status).type("application/problem+json").send({
    type: `https://lorb.example/errors/${failure.code}`,
    title: "We could not complete that request",
    status: failure.status,
    code: failure.code,
    detail: "Please check the request and try again",
    correlation_id,
    retryable: failure.status >= 500,
    field_errors: [],
  });
}
