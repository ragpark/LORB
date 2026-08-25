/**
 * Which environment a front end is running against, and how it says so.
 *
 * The consoles used to carry a permanent banner declaring the whole platform a draft. That notice
 * has done its job. What replaces it is narrower and more useful for the rest of the system's life:
 * a non-production environment says which one it is, and production says nothing, so an operator can
 * always tell at a glance whether the records in front of them are real.
 */

export type EnvironmentLabel = "PRODUCTION" | "STAGING" | "DEVELOPMENT";

export const ENVIRONMENT_LABELS: readonly EnvironmentLabel[] = ["PRODUCTION", "STAGING", "DEVELOPMENT"];

export function isEnvironmentLabel(value: unknown): value is EnvironmentLabel {
  return typeof value === "string" && (ENVIRONMENT_LABELS as readonly string[]).includes(value);
}

/**
 * The notice a non-production environment shows. Returns undefined in production: a banner that is
 * always on stops being read, and one that appears only when something is unusual keeps working.
 */
export function environmentNotice(label: EnvironmentLabel): string | undefined {
  if (label === "PRODUCTION") return undefined;
  if (label === "STAGING") return "Staging environment. Changes here do not affect production, and the data is not production data.";
  return "Development environment. Data here is local and disposable.";
}

/** True where the front end may fall back to a development sign-in instead of the real provider. */
export function allowsDevelopmentSignIn(label: EnvironmentLabel): boolean {
  return label === "DEVELOPMENT";
}
