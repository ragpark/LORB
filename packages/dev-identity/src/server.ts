/**
 * The development identity provider.
 *
 * Mints a short-lived access token for whatever subject it is given. There is no password, no
 * consent and no user directory, which is exactly why the Runtime API accepts it only when
 * ALLOW_SYNTHETIC_IDENTITY is set and production configuration refuses that flag outright.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { exportJWK, generateKeyPair } from "jose";
import { DEV_IDENTITY_KID, issueIesToken } from "./issuer.js";
import { devJwks } from "./jwks.js";

const issuer = (process.env.IES_PUBLIC_ISSUER ?? "http://localhost:4000").replace(/\/$/, "");
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
// Built from the same identifier the issuer stamps, so the two cannot drift apart.
const jwks = devJwks(await exportJWK(publicKey));

/**
 * The same identifier shape the roster accepts, so a learner added to a class and that learner's own
 * sign-in derive the same pseudonym. Bounded rather than free-form: an identifier that could not
 * round-trip through a real provider would let a developer build a roster the platform cannot serve.
 */
const SUBJECT = /^[A-Za-z\d._:-]{1,128}$/;

const app = Fastify({ logger: true });
await app.register(cors, { origin: true, methods: ["GET", "POST"] });

app.get("/health", async () => ({ status: "ok", kid: DEV_IDENTITY_KID }));
app.get("/.well-known/jwks.json", async () => jwks);

app.post("/dev-login", async (req, reply) => {
  const body = (req.body ?? {}) as { subject?: unknown; role?: unknown; platform_admin?: unknown };
  const query = (req.query ?? {}) as { role?: unknown; platform_admin?: unknown };

  const subject = body.subject;
  if (typeof subject !== "string" || !SUBJECT.test(subject)) {
    return reply.code(400).send({ code: "SUBJECT_INVALID", detail: "subject must be 1-128 characters of A-Z a-z 0-9 . _ : -" });
  }

  const role = body.role ?? query.role;
  if (role !== undefined && role !== "admin") {
    return reply.code(400).send({ code: "UNSUPPORTED_ROLE", detail: "the development provider issues the admin role only" });
  }

  const platformAdmin = body.platform_admin === true || query.platform_admin === "true";
  const claims = role === "admin" ? { role: "admin", ...(platformAdmin ? { platform_admin: true } : {}) } : {};

  return {
    access_token: await issueIesToken(privateKey, subject, "lorb-runtime", issuer, claims),
    token_type: "Bearer",
    expires_in: 600,
  };
});

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4000) });
