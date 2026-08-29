/**
 * The launch-context form's pure half: turning what a publisher typed into the payload the
 * publisher API accepts, and telling them — in their own words — what is wrong before it refuses.
 * Mirrors launchContextSchema in packages/contracts: keys are lowercase tokens, values scalars,
 * at most 16 settings.
 */
export type SettingRow = { key: string; value: string };

export const SETTING_KEY = /^[a-z][a-z\d_]{0,63}$/;
// Keys the admin leak guard (lib/redaction.ts) would redact on display — a setting is publisher
// configuration, never a credential, so refuse the collision up front rather than showing a saved
// value as leaked.
export const RESERVED_SETTING_KEY = /(^|_)(subject|tenant_secret|private_key|token|signed_descriptor|bearer)($|_)/;

/** Rows an author actually filled in; a fully blank row is scaffolding, not intent. */
export const keptRows = (rows: SettingRow[]): SettingRow[] =>
  rows.filter((row) => row.key.trim() !== '' || row.value.trim() !== '');

/**
 * "true"/"false" and numerics travel as their scalar selves; everything else is a string. Wrapping
 * a value in double quotes forces text — how an author says the *string* "true" or "3", and how
 * such a stored string is shown back so a later save cannot silently change its type.
 */
export const settingValue = (raw: string): string | number | boolean => {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
};

/** The stored scalar as the form shows it: the exact text that parses back to the same value. */
export const settingDisplay = (value: string | number | boolean): string => {
  if (typeof value !== 'string') return String(value);
  // A string the parser would read as something else — a boolean/number lookalike, or one that is
  // itself quote-wrapped — travels quoted so it survives the round trip as the string it is.
  return settingValue(value) === value ? value : `"${value}"`;
};

/** The first thing an author must fix, named in their words — or '' when the rows are sendable. */
export function settingsProblem(rows: SettingRow[]): string {
  const kept = keptRows(rows);
  const keys = kept.map((row) => row.key.trim());
  const bad = keys.find((key) => !SETTING_KEY.test(key));
  if (bad !== undefined) return `"${bad}" is not a valid setting name — lowercase letters, digits and underscores, starting with a letter.`;
  const reserved = keys.find((key) => RESERVED_SETTING_KEY.test(key));
  if (reserved !== undefined) return `"${reserved}" is a reserved name — settings are configuration, never credentials.`;
  if (new Set(keys).size !== keys.length) return 'Setting names must be unique.';
  if (keys.length > 16) return 'At most 16 settings.';
  const long = kept.find((row) => row.value.length > 256);
  if (long) return `The value of "${long.key}" is over 256 characters.`;
  return '';
}

/**
 * Whether the form differs from what is stored, independent of setting order — the production
 * store's jsonb round trip does not preserve key order, so an order-sensitive comparison would
 * leave Save enabled and publish redundant versions.
 */
export function contextEquals(
  a: { theme?: string; settings?: Record<string, string | number | boolean> } | null,
  b: { theme?: string; settings?: Record<string, string | number | boolean> } | null,
): boolean {
  const canonical = (context: typeof a): string => JSON.stringify({
    theme: context?.theme,
    settings: Object.entries(context?.settings ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  });
  return canonical(a) === canonical(b);
}

/** The PUT body's launch_context value: an object with only what was set, or null to clear. */
export function launchContextPayload(theme: string, rows: SettingRow[]): { theme?: string; settings?: Record<string, string | number | boolean> } | null {
  const kept = keptRows(rows);
  const payload = {
    ...(theme ? { theme } : {}),
    ...(kept.length > 0 ? { settings: Object.fromEntries(kept.map((row) => [row.key.trim(), settingValue(row.value)])) } : {}),
  };
  return Object.keys(payload).length > 0 ? payload : null;
}
