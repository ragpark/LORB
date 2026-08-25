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

  it("does not bake a development sign-in endpoint into the image", () => {
    expect(dockerfile).not.toContain("ARG VITE_STUB_IES_LOGIN_URL");
    expect(dockerfile).not.toContain("ARG VITE_DEVELOPMENT_LOGIN_URL");
  });

  it("sets the response headers a static origin should always carry", () => {
    expect(dockerfile).toContain("X-Content-Type-Options nosniff");
    expect(dockerfile).toContain("X-Frame-Options DENY");
  });

  it("does not require or inject a separate Runtime issuer build argument", () => {
    expect(dockerfile).not.toContain("ARG VITE_RUNTIME_ISSUER");
    expect(dockerfile).not.toContain("ENV VITE_RUNTIME_ISSUER");
    expect(dockerfile).not.toContain('test -n "${VITE_RUNTIME_ISSUER}"');
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
