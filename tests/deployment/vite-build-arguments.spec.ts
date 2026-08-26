/**
 * Every setting a front end reads can actually be set when its image is built.
 *
 * Vite substitutes `import.meta.env.VITE_*` at build time, so a value that does not reach the build
 * cannot reach the bundle. In a container that means the variable must be declared `ARG` and put back
 * on the environment with `ENV`; a variable the image never receives leaves the compiled bundle
 * holding whatever default the source falls back to.
 *
 * That is not a theoretical gap. The development sign-in URL was renamed during the production work,
 * the deployment was updated, and the Dockerfiles were not — so all three front ends shipped with
 * `http://localhost:4000/dev-login` compiled in, and every deployed sign-in tried to reach the
 * learner's own machine. Nothing failed at build or deploy time; the only symptom was a failed fetch
 * in a browser, naming a host that appears nowhere in the deployment.
 *
 * So the rule is checked rather than remembered: whatever a front end reads, its image must accept.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Front-end packages built by their own image, and the Dockerfile that builds each. */
const IMAGES: Record<string, string> = {
  "admin-ui": "Dockerfile.admin-ui",
  "ops-console": "Dockerfile.ops-console",
  "learner-portal": "Dockerfile.learner-portal",
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

/**
 * The settings the package actually reads. Deliberately taken from the source rather than from the
 * `vite-env.d.ts` declarations: the type declaration says what is allowed to exist, and what matters
 * here is what the built code will go looking for.
 */
function settingsRead(packageName: string): string[] {
  const referenced = sourceFiles(`packages/${packageName}/src`)
    .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/env\.(VITE_[A-Z0-9_]+)/g)].map((match) => match[1]!));
  return [...new Set(referenced)].sort();
}

describe.each(Object.entries(IMAGES))("%s", (packageName, dockerfilePath) => {
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  const settings = settingsRead(packageName);

  it("reads at least one build-time setting, or this check is measuring nothing", () => {
    expect(settings.length).toBeGreaterThan(0);
  });

  it.each(settings)("%s can be supplied to the image", (setting) => {
    // ARG makes it accepted at build time; ENV puts it where Vite will read it.
    expect(dockerfile, `${dockerfilePath} needs: ARG ${setting}`).toMatch(new RegExp(`^ARG ${setting}$`, "m"));
    expect(dockerfile, `${dockerfilePath} needs: ENV ${setting}=\${${setting}}`)
      .toMatch(new RegExp(`^ENV ${setting}=\\$\\{${setting}\\}$`, "m"));
  });
});
