/**
 * Generates descriptor signing key material.
 *
 * Usage:
 *   pnpm keys:generate                       # prints a new ACTIVE key as PEM plus its kid
 *   pnpm keys:generate --rotate <old-kid>    # prints DESCRIPTOR_SIGNING_KEYS for a rotation window,
 *                                            # reading the current key from the environment
 *
 * The rotation form is the one that matters operationally: it emits a ring containing the new ACTIVE
 * key and the previous key marked RETIRING, so descriptors already in flight keep verifying while
 * the new key takes over signing. Drop the RETIRING entry once the descriptor lifetime has elapsed.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";

function newKey(): { kid: string; pem: string } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    kid: `lorb-descriptor-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const args = process.argv.slice(2);
const rotateIndex = args.indexOf("--rotate");
const fresh = newKey();

if (rotateIndex === -1) {
  process.stdout.write(`# Write the PEM to a secret store and reference it as DESCRIPTOR_PRIVATE_KEY_PATH,\n`);
  process.stdout.write(`# or set DESCRIPTOR_PRIVATE_KEY_PEM directly.\n`);
  process.stdout.write(`DESCRIPTOR_KID=${fresh.kid}\n\n${fresh.pem}`);
} else {
  const previousKid = args[rotateIndex + 1] ?? process.env.DESCRIPTOR_KID;
  const previousPem = process.env.DESCRIPTOR_PRIVATE_KEY_PEM;
  if (!previousKid || !previousPem) {
    process.stderr.write("--rotate needs the current key: set DESCRIPTOR_KID and DESCRIPTOR_PRIVATE_KEY_PEM in the environment.\n");
    process.exit(1);
  }
  const ring = [
    { kid: fresh.kid, pem: fresh.pem, state: "ACTIVE" },
    { kid: previousKid, pem: previousPem.replace(/\\n/g, "\n"), state: "RETIRING" },
  ];
  process.stdout.write(`# Set as DESCRIPTOR_SIGNING_KEYS. Remove the RETIRING entry after the descriptor\n`);
  process.stdout.write(`# lifetime (10 minutes) has elapsed on every replica.\n`);
  process.stdout.write(`${JSON.stringify(ring)}\n`);
}
