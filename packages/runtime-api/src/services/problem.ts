/**
 * RFC 9457 problem details, shared by every surface.
 *
 * The error taxonomy is a contract: a consumer branches on `code`, and an operator uses
 * `correlation_id` to find the request. Both are therefore always present, and the human-readable
 * fields never carry anything from the request — a detail string that echoes input is how learner
 * content ends up in somebody's error log.
 */

export const PROBLEM_TYPE_BASE = process.env.PROBLEM_TYPE_BASE ?? "https://lorb.example/errors";

const STATUS_BY_CODE: Record<string, number> = {
  LAUNCH_CONTEXT_INVALID: 400,
  AUTHENTICATION_EXPIRED: 401,
  ACCESS_DENIED: 403,
  ENTITLEMENT_UNAVAILABLE: 403,
  OBJECT_NOT_FOUND: 404,
  OBJECT_NOT_PUBLISHED: 409,
  OBJECT_RETIRED: 410,
  PACKAGE_UNAVAILABLE: 409,
  PLAYER_UNSUPPORTED: 409,
  BROWSER_UNSUPPORTED: 400,
  NETWORK_INTERRUPTED: 503,
  PROVIDER_UNAVAILABLE: 503,
  STATE_LOAD_FAILED: 500,
  STATE_SAVE_FAILED: 500,
  ATTEMPT_CONFLICT: 409,
  ATTEMPT_LIMIT_REACHED: 409,
  SESSION_EXPIRED: 401,
  CONTENT_SECURITY_BLOCKED: 403,
  PLAYER_RUNTIME_ERROR: 500,
  EVIDENCE_DELIVERY_DELAYED: 202,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  SMART_LINK_NOT_FOUND: 404,
  LEARNING_OBJECT_NOT_AVAILABLE: 410,
  UNKNOWN_ERROR: 500,
};

const TITLE_BY_CODE: Record<string, string> = {
  AUTHENTICATION_EXPIRED: "Your session has expired",
  SESSION_EXPIRED: "Your session has expired",
  ACCESS_DENIED: "You do not have access to this activity",
  OBJECT_NOT_FOUND: "That learning object could not be found",
  OBJECT_NOT_PUBLISHED: "That learning object is not published",
  OBJECT_RETIRED: "That learning object has been retired",
  ATTEMPT_CONFLICT: "That attempt has already moved on",
  IDEMPOTENCY_KEY_REQUIRED: "An idempotency key is required",
  IDEMPOTENCY_KEY_REUSED: "That idempotency key was used for a different request",
  RATE_LIMITED: "Too many requests",
  SERVICE_UNAVAILABLE: "The service is temporarily unavailable",
  SMART_LINK_NOT_FOUND: "That link is no longer available",
  LEARNING_OBJECT_NOT_AVAILABLE: "That activity is no longer available",
};

const DETAIL_BY_CODE: Record<string, string> = {
  AUTHENTICATION_EXPIRED: "Sign in again to continue.",
  SESSION_EXPIRED: "Sign in again to continue.",
  IDEMPOTENCY_KEY_REQUIRED: "Send an Idempotency-Key header with this request.",
  IDEMPOTENCY_KEY_REUSED: "Use a new idempotency key, or repeat the original request unchanged.",
  RATE_LIMITED: "Wait a moment and try again.",
  SERVICE_UNAVAILABLE: "Try again shortly.",
};

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  correlation_id: string;
  retryable: boolean;
  field_errors: unknown[];
}

export function problemFor(code: string, correlationId: string, status = STATUS_BY_CODE[code] ?? 400): ProblemDetails {
  return {
    type: `${PROBLEM_TYPE_BASE}/${code}`,
    title: TITLE_BY_CODE[code] ?? "We could not complete that request",
    status,
    code,
    detail: DETAIL_BY_CODE[code] ?? "Please check the request and try again.",
    correlation_id: correlationId,
    retryable: status >= 500 || status === 429,
    field_errors: [],
  };
}

export function statusForCode(code: string): number {
  return STATUS_BY_CODE[code] ?? 400;
}

/** Replies with a problem document and the matching status and content type. */
export function sendProblem(reply: { code: (status: number) => { type: (value: string) => { send: (body: unknown) => unknown } } }, code: string, correlationId: string, status = STATUS_BY_CODE[code] ?? 400) {
  return reply.code(status).type("application/problem+json").send(problemFor(code, correlationId, status));
}
