/**
 * What the folded topology loads at run time must survive the production install.
 *
 * `SERVE_MCP_CONNECTOR=true` makes the API process import the agent connector, so the connector's
 * dependencies become the API image's dependencies. The API image is built by `Dockerfile`, which
 * runs `pnpm prune --prod` and then copies only the root `node_modules` into the runtime stage. Two
 * consequences follow, and together they are easy to miss:
 *
 *  - A package declared only under root `devDependencies` is gone after the prune.
 *  - The connector's compiled output lives under `dist/`, so Node resolves its imports by walking up
 *    from there to the root `node_modules`. A workspace package's own `node_modules` is never on
 *    that path, which is why declaring the dependency on the connector package alone is not enough.
 *
 * The failure mode is the worst kind: nothing is wrong at build time, the image is produced, and the
 * process dies at start-up with a module-resolution error the first time somebody turns the flag on.
 * `@modelcontextprotocol/sdk` was exactly this, declared under devDependencies and on the connector
 * package, and reachable in a workspace checkout but not in the image.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const rootManifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** Bare specifiers a directory's sources import, ignoring relative paths and Node built-ins. */
function externalImports(directory: string): string[] {
  const specifiers = readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts"))
    .flatMap((entry) => [...readFileSync(join(directory, entry), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!))
    .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"));
  // A subpath import such as `@scope/name/dist/thing.js` is satisfied by the package it names.
  const packageOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  return [...new Set(specifiers.map(packageOf))].sort();
}

describe("the agent connector, folded into the API process", () => {
  const imports = externalImports("packages/mcp-connector/src");

  it("imports something from outside the workspace, or this check is measuring nothing", () => {
    expect(imports.length).toBeGreaterThan(0);
  });

  it.each(imports)("%s is a production dependency of the root package", (specifier) => {
    expect(
      rootManifest.dependencies ?? {},
      `${specifier} must be in the root package.json "dependencies". The API image prunes devDependencies `
        + "and copies only the root node_modules, so the folded connector would fail to start.",
    ).toHaveProperty(specifier);
  });

  it("does not leave any of them behind in devDependencies, where the prune would remove them", () => {
    const stillDevOnly = imports.filter((specifier) => !(specifier in (rootManifest.dependencies ?? {})));
    expect(stillDevOnly).toEqual([]);
  });
});
