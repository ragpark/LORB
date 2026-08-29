// Mirrors the header-redaction approach already proven safe in the Ops Console (packages/ops-console/src/security.ts):
// plain object mapping, never Headers.set() — the Learner Portal crashed doing that with a non-ASCII "…redacted…" string.
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
// A smart link's `token` is the public share secret embedded in its `url` — the whole point is for
// it to reach the DOM so an admin can copy and share it. Scoped to siblings of `smart_link_id` so a
// genuine bearer/access token elsewhere in a payload still trips the leak guard.
const isApprovedSmartLinkTokenField = (key: string, parent: Record<string, unknown>) => key === 'token' && typeof parent.smart_link_id === 'string';
// A quiz's `subject` is a curriculum subject ("Science"), not an identity — the name collision with
// the banned raw-identity field is unfortunate but the contract already shipped. Scoped to the quiz
// content shape (a sibling `questions` array), so a genuine subject claim anywhere else still trips
// the guard.
const isApprovedQuizSubjectField = (key: string, parent: Record<string, unknown>) => key === 'subject' && Array.isArray(parent.questions);
const isForbiddenKey = (key: string, parent: Record<string, unknown>) => !isApprovedPseudonymField(key) && !isApprovedSmartLinkTokenField(key, parent) && !isApprovedQuizSubjectField(key, parent) && forbiddenKey.test(key);

export function containsForbiddenField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const parent = value as Record<string, unknown>;
  return Object.entries(parent).some(([key, item]) => isForbiddenKey(key, parent) || containsForbiddenField(item));
}

export function redactForbiddenFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactForbiddenFields) as T;
  if (value && typeof value === 'object') {
    const parent = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parent).flatMap(([key, item]) => (isForbiddenKey(key, parent) ? [] : [[key, redactForbiddenFields(item)]])),
    ) as T;
  }
  return value;
}
