import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("Dockerfile.learner-portal", "utf8");
const railway = JSON.parse(readFileSync("railway.learner-portal.json", "utf8")) as {
  build: { dockerfilePath: string };
  deploy: Record<string, unknown>;
};

describe("learner portal deployment", () => {
  it("installs every workspace the portal needs before building it", () => {
    const install = dockerfile.indexOf("RUN pnpm install");
    expect(dockerfile.indexOf("COPY packages/learner-portal/package.json")).toBeLessThan(install);
    expect(dockerfile.indexOf("COPY packages/web-auth/package.json")).toBeLessThan(install);
    expect(dockerfile).toContain("RUN pnpm --filter learner-portal build");
  });

  it("requires the complete build configuration", () => {
    for (const variable of [
      "VITE_RUNTIME_API_BASE",
      "VITE_JWKS_URL",
      "VITE_PLAYER_SHELL_ORIGIN",
      "VITE_ENVIRONMENT_LABEL",
      "VITE_ALLOWED_SHELL_ORIGINS",
      "VITE_OIDC_ISSUER",
      "VITE_OIDC_CLIENT_ID",
    ]) {
      expect(dockerfile).toContain(`ARG ${variable}`);
    }
    expect(dockerfile).toContain("PRODUCTION|STAGING|DEVELOPMENT");
    expect(dockerfile).toContain('test "${VITE_ALLOWED_SHELL_ORIGINS}" != "*"');
  });

  // The one build-time check that decides whether the deployed portal has authentication at all:
  // without a provider, the local sign-in would be the only way in, and it accepts a chosen subject.
  it("refuses to build a deployed portal with no identity provider", () => {
    expect(dockerfile).toContain('if [ "${VITE_ENVIRONMENT_LABEL}" != "DEVELOPMENT" ]');
    expect(dockerfile).toContain('required outside development');
  });

  // The development sign-in accepts a chosen subject, so a deployed portal carrying one has no
  // authentication at all. It was previously kept out by refusing the build argument entirely — which
  // also meant a development *deployment* could never sign in, because the bundle kept its localhost
  // default and the browser tried to reach the learner's own machine. The endpoint is now settable
  // and the ban moved to where the risk actually is: it must be empty unless the image is a
  // development one, which is the same condition that already demands a real provider.
  it("permits a development sign-in endpoint only in a development image", () => {
    expect(dockerfile).toContain("ARG VITE_DEVELOPMENT_LOGIN_URL");
    expect(dockerfile).toContain('test -z "${VITE_DEVELOPMENT_LOGIN_URL}"');
    expect(dockerfile).toContain('test -z "${VITE_DEVELOPMENT_IDENTITY_LOGIN_URL}"');
    expect(dockerfile).toContain("the development sign-in must not be built into a non-development image");
  });

  it("sets the response headers a static origin should always carry", () => {
    expect(dockerfile).toContain("X-Content-Type-Options nosniff");
    expect(dockerfile).toContain("X-Frame-Options DENY");
  });

  it("does not require or inject a separate Runtime issuer build argument", () => {
    expect(dockerfile).not.toContain("ARG VITE_RUNTIME_ISSUER");
    expect(dockerfile).not.toContain("ENV VITE_RUNTIME_ISSUER");
    expect(dockerfile).not.toContain('test -n "${VITE_RUNTIME_ISSUER}"');
    // And the portal does not read one either, so the image and the code agree that it is derived.
    expect(readFileSync("packages/learner-portal/src/config.ts", "utf8")).not.toContain("VITE_RUNTIME_ISSUER");
  });

  it("serves static output with health and SPA fallback routes", () => {
    expect(dockerfile).toContain("COPY --from=build /app/packages/learner-portal/dist /usr/share/nginx/html");
    expect(dockerfile).toContain("location = /health");
    expect(dockerfile).toContain("try_files $uri $uri/ /index.html");
  });

  it("uses the dedicated image without an API pre-deploy command", () => {
    expect(railway.build.dockerfilePath).toBe("Dockerfile.learner-portal");
    expect(railway.deploy.healthcheckPath).toBe("/health");
    expect(railway.deploy).not.toHaveProperty("preDeployCommand");
  });
});
