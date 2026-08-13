import { createHmac } from "node:crypto";
/** Convert an upstream identity into a LORB pseudonym. The subject must never be logged. */
export function computePseudonym(tenantSecret: Buffer, issuer: string, subject: string, purpose: string): string {
  const input = `${issuer}|${subject}|${purpose}`;
  return createHmac("sha256", tenantSecret).update(input).digest("hex");
}
export function loadTenantSecret(value: string | undefined): Buffer {
  if (!value || !/^[a-f\d]{64}$/i.test(value)) throw new Error("Pseudonym configuration is unavailable");
  return Buffer.from(value, "hex");
}
