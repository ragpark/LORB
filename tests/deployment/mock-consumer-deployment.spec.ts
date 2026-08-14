import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("Dockerfile.mock-consumer", "utf8");
const railway = JSON.parse(readFileSync("railway.mock-consumer.json", "utf8")) as {
  build: { dockerfilePath: string };
  deploy: Record<string, unknown>;
};

describe("mock consumer non-production deployment", () => {
  it("installs the mock workspace before building it", () => {
    const install = dockerfile.indexOf("RUN pnpm install");
    expect(dockerfile.indexOf("COPY packages/mock-consumer/package.json")).toBeLessThan(install);
    expect(dockerfile).toContain("RUN pnpm --filter mock-consumer build");
  });

  it("requires the complete non-production build configuration", () => {
    for (const variable of [
      "VITE_RUNTIME_API_BASE",
      "VITE_JWKS_URL",
      "VITE_PLAYER_SHELL_ORIGIN",
      "VITE_STUB_IES_ISSUER",
      "VITE_STUB_IES_LOGIN_URL",
      "VITE_ENVIRONMENT_LABEL",
      "VITE_ALLOWED_SHELL_ORIGINS",
    ]) {
      expect(dockerfile).toContain(`ARG ${variable}`);
    }
    expect(dockerfile).toContain('test "${VITE_ENVIRONMENT_LABEL}" = "RAILWAY-NON-PROD"');
    expect(dockerfile).toContain('test "${VITE_ALLOWED_SHELL_ORIGINS}" != "*"');
  });

  it("serves static output with health and SPA fallback routes", () => {
    expect(dockerfile).toContain("COPY --from=build /app/packages/mock-consumer/dist /usr/share/nginx/html");
    expect(dockerfile).toContain("location = /health");
    expect(dockerfile).toContain("try_files $uri $uri/ /index.html");
  });

  it("uses the dedicated image without an API pre-deploy command", () => {
    expect(railway.build.dockerfilePath).toBe("Dockerfile.mock-consumer");
    expect(railway.deploy.healthcheckPath).toBe("/health");
    expect(railway.deploy).not.toHaveProperty("preDeployCommand");
  });
});
