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

/** "true"/"false" and numerics travel as their scalar selves; everything else is a string. */
export const settingValue = (raw: string): string | number | boolean => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
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

/** The PUT body's launch_context value: an object with only what was set, or null to clear. */
export function launchContextPayload(theme: string, rows: SettingRow[]): { theme?: string; settings?: Record<string, string | number | boolean> } | null {
  const kept = keptRows(rows);
  const payload = {
    ...(theme ? { theme } : {}),
    ...(kept.length > 0 ? { settings: Object.fromEntries(kept.map((row) => [row.key.trim(), settingValue(row.value)])) } : {}),
  };
  return Object.keys(payload).length > 0 ? payload : null;
}
