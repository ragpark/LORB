/**
 * Every image installs the workspace it actually builds.
 *
 * pnpm resolves `workspace:*` dependencies from the manifests present on disk at install time, so a
 * Dockerfile that copies a hand-written subset of the package manifests before `pnpm install` is
 * keeping a second, informal copy of the dependency graph. It drifts the first time somebody adds a
 * package: `@lorb/web-auth` arrived as a dependency of three front ends, the root Dockerfile's list
 * was not updated, and every Runtime API image build failed with
 *
 *     ERR_PNPM_WORKSPACE_PKG_NOT_FOUND  In packages/learner-portal: "@lorb/web-auth@workspace:*"
 *     is in the dependencies but no package named "@lorb/web-auth" is present in the workspace
 *
 * Nothing in the test suite noticed, because the property was asserted for one Dockerfile rather
 * than for all of them. This checks every image: whatever a Dockerfile builds, the manifests of that
 * package and of everything it depends on across the workspace must be installable when it installs.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Workspace package directory name → declared package name, and its workspace dependencies. */
interface WorkspacePackage {
  directory: string;
  name: string;
  workspaceDependencies: string[];
}

const packages: WorkspacePackage[] = readdirSync("packages", { withFileTypes: true })
  // `packages/*` in pnpm-workspace.yaml makes a directory a workspace only when it has a manifest;
  // several here are plain source directories consumed by relative import.
  .filter((entry) => entry.isDirectory() && existsSync(`packages/${entry.name}/package.json`))
  .map((entry) => {
    const manifest = JSON.parse(readFileSync(`packages/${entry.name}/package.json`, "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      directory: entry.name,
      name: manifest.name,
      workspaceDependencies: Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
        .filter(([, range]) => range.startsWith("workspace:"))
        .map(([dependency]) => dependency),
    };
  });

const byName = new Map(packages.map((workspace) => [workspace.name, workspace]));
const dockerfiles = readdirSync(".").filter((name) => name === "Dockerfile" || name.startsWith("Dockerfile."));

/** The package and everything it needs from the workspace, transitively. */
function withWorkspaceDependencies(start: WorkspacePackage): WorkspacePackage[] {
  const seen = new Map<string, WorkspacePackage>();
  const queue = [start];
  while (queue.length) {
    const workspace = queue.shift()!;
    if (seen.has(workspace.name)) continue;
    seen.set(workspace.name, workspace);
    for (const dependency of workspace.workspaceDependencies) {
      const resolved = byName.get(dependency);
      // A `workspace:*` range naming a package that does not exist is the failure itself.
      expect(resolved, `${workspace.name} depends on ${dependency}, which is not in the workspace`).toBeDefined();
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen.values()];
}

/** What a Dockerfile builds: an explicit `--filter`, or every package when it runs the root build. */
function packagesBuiltBy(dockerfile: string): WorkspacePackage[] {
  const filtered = [...dockerfile.matchAll(/pnpm --filter (\S+) build/g)].map((match) => match[1]!);
  if (filtered.length) return filtered.map((name) => byName.get(name)).filter((found): found is WorkspacePackage => Boolean(found));
  // The root build compiles the whole workspace and then builds each front end in turn.
  return /RUN pnpm build\b/.test(dockerfile) ? packages : [];
}

describe.each(dockerfiles)("%s", (filename) => {
  const dockerfile = readFileSync(filename, "utf8");
  const install = dockerfile.indexOf("RUN pnpm install");

  it("has every manifest it needs on disk before pnpm install", () => {
    if (install === -1) return; // Nothing to check: this image does not install the workspace.

    const beforeInstall = dockerfile.slice(0, install);
    // Copying the whole tree cannot drift, and is how the root image avoids maintaining a list.
    const copiesWholeWorkspace = /^COPY packages \.\/packages$/m.test(beforeInstall);

    const missing = packagesBuiltBy(dockerfile)
      .flatMap(withWorkspaceDependencies)
      .filter((workspace) => !copiesWholeWorkspace
        && !beforeInstall.includes(`COPY packages/${workspace.directory}/package.json`))
      .map((workspace) => `${workspace.name} (packages/${workspace.directory})`);

    expect([...new Set(missing)], `${filename} builds these but installs without their manifests`).toEqual([]);
  });
});
