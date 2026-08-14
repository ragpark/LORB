// Mirrors the header-redaction approach already proven safe in the Ops Console (packages/ops-console/src/security.ts):
// plain object mapping, never Headers.set() — the Mock Consumer crashed doing that with a non-ASCII "…redacted…" string.
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, key.toLowerCase() === 'authorization' ? 'Bearer ...redacted...' : value]));
}

// Never let a raw upstream subject, tenant secret, private key, bearer token, or signed descriptor reach a log line or the DOM.
const forbiddenKey = /(^|_)(subject|tenant_secret|private_key|token|signed_descriptor|bearer)($|_)/i;
// Any key ending in _pseudonym (or exactly "pseudonym") is, by construction, already the safe
// representation the "subject" ban exists to require — e.g. principal_subject_pseudonym would
// otherwise false-positive on the "_subject_" substring. Mirrors Ops Console's own
// approvedProjectionKeys allowlist for the same class of field (packages/ops-console/src/security.ts).
const isApprovedPseudonymField = (key: string) => key === 'pseudonym' || key.endsWith('_pseudonym');
const isForbiddenKey = (key: string) => !isApprovedPseudonymField(key) && forbiddenKey.test(key);

export function containsForbiddenField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => isForbiddenKey(key) || containsForbiddenField(item));
}

export function redactForbiddenFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactForbiddenFields) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => (isForbiddenKey(key) ? [] : [[key, redactForbiddenFields(item)]])),
    ) as T;
  }
  return value;
}
