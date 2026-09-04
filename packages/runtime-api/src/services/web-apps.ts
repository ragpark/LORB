/**
 * Serving the browser applications from the API process.
 *
 * The learner portal, the administration workspace and the operations console are static bundles.
 * They can be served from their own origins, which is what a deployment does today, or from this
 * process, which is what `SERVE_WEB_APPS` turns on. Nothing about the applications changes between
 * the two: the same built bundles are served either way, and this module is the only thing that
 * knows the difference.
 *
 * Two problems have to be solved for the folded topology to be worth having.
 *
 * The first is configuration. Vite bakes `VITE_*` values into the bundle at build time, so a bundle
 * built for staging is a different artifact from the one built for production. That is the opposite
 * of what a container image promoted through environments needs. So the values are written into the
 * page at request time instead, from this process's own environment, and the bundles read them
 * through their `runtime-env` module. One image, any environment.
 *
 * The second is the content security policy. The API is served under `default-src 'none'`, which is
 * right for JSON and fatal for an application: it would block every script, style and image the
 * page needs. Each application is therefore mounted in its own encapsulated scope with a policy
 * scoped to it, in the same way `/api/v1/lti/authorize` overrides the global policy for the one
 * route that needs it. No API route is affected.
 *
 * The Player Shell is deliberately not here, and cannot be. It serves
 * `Access-Control-Allow-Origin: *` so that modules sandboxed without `allow-same-origin` can fetch
 * their own bundles from an opaque origin. Serving it from this origin would put wildcard CORS on
 * an authenticated API.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { RuntimeConfig } from "../config/index.js";

export interface WebAppDefinition {
  /** Directory name under a bundle root, and the path this application is served at. */
  slug: string;
  /** Workspace package whose `dist` holds the built bundle. */
  packageName: string;
  title: string;
}

/**
 * The applications this process can serve, and where each one lives.
 *
 * The prefixes are part of the deployment's URL contract once this is switched on: an identity
 * provider's redirect URIs name them, and so does anything anyone has bookmarked. They are fixed
 * here rather than configured so that two deployments of the same image agree on them.
 */
export const WEB_APPS: readonly WebAppDefinition[] = [
  { slug: "portal", packageName: "learner-portal", title: "Learner portal" },
  { slug: "admin", packageName: "admin-ui", title: "Administration workspace" },
  { slug: "console", packageName: "ops-console", title: "Operations console" },
];

export const webAppPrefix = (app: WebAppDefinition): string => `/${app.slug}`;

/**
 * Where a built bundle might be, in the order the layouts are preferred.
 *
 * A configured root is the only place looked at, because configuration that can be silently
 * overruled is worse than no configuration: an operator who names a directory and gets a bundle
 * from somewhere else has no way to tell from the outside, and would be serving a stale application
 * that looks entirely healthy. Naming a root and getting a refusal is the diagnosable outcome.
 *
 * Unconfigured, both known layouts are probed: the container image copies the bundles to
 * `web/<slug>`, and a workspace checkout has them in the package's own `dist` after `pnpm build`.
 * That is what lets the flag behave the same way in a container and on a developer's machine
 * without either having to set a path.
 */
export function webAppRootCandidates(app: WebAppDefinition, configuredRoot: string | undefined, cwd = process.cwd()): string[] {
  if (configuredRoot) return [join(resolve(cwd, configuredRoot), app.slug)];
  return [join(cwd, "web", app.slug), join(cwd, "packages", app.packageName, "dist")];
}

/** The first candidate directory that exists and holds an `index.html`, or undefined. */
export function resolveWebAppRoot(app: WebAppDefinition, configuredRoot: string | undefined, cwd = process.cwd()): string | undefined {
  return webAppRootCandidates(app, configuredRoot, cwd).find((candidate) => existsSync(join(candidate, "index.html")));
}

const ENVIRONMENT_LABELS: Record<string, string> = { production: "PRODUCTION", staging: "STAGING", development: "DEVELOPMENT", test: "DEVELOPMENT" };

/**
 * The configuration handed to one application's bundle in the browser.
 *
 * Only variables named `VITE_*` are forwarded from this process's environment. That is the same
 * prefix Vite itself uses to decide what may reach a browser, so the rule an operator already
 * follows for the separate-origin topology is the rule that applies here: a `VITE_` name is public,
 * and anything secret does not carry one. Nothing outside that prefix is forwarded.
 *
 * The API bases default to this origin, because in this topology they are this origin, which is
 * also what removes cross-origin requests from the first-party path entirely. The OIDC redirect URI
 * is always derived rather than forwarded: the only correct value is where the application is
 * actually mounted, and a single forwarded value would be wrong for two of the three.
 */
export function webAppEnvironment(app: WebAppDefinition, config: RuntimeConfig): Record<string, string> {
  const issuer = config.publicIssuer.replace(/\/$/, "");
  const derived: Record<string, string> = {
    VITE_RUNTIME_API_BASE: `${issuer}/api/v1/runtime`,
    VITE_ADMIN_API_BASE: `${issuer}/api/v1/admin`,
    VITE_PUBLISHER_API_BASE: `${issuer}/api/v1/publisher`,
    VITE_EVIDENCE_API_BASE: `${issuer}/api/v1/evidence`,
    VITE_JWKS_URL: `${issuer}/api/v1/runtime/jwks`,
    VITE_ALLOWED_API_ORIGINS: new URL(issuer).origin,
    VITE_PLAYER_SHELL_ORIGIN: config.playerOrigin,
    VITE_ALLOWED_SHELL_ORIGINS: config.playerOrigin,
    VITE_ENVIRONMENT_LABEL: ENVIRONMENT_LABELS[config.environment] ?? "DEVELOPMENT",
  };
  const forwarded = Object.fromEntries(
    Object.entries(process.env)
      .filter(([name, value]) => name.startsWith("VITE_") && typeof value === "string" && value.trim() !== "")
      .map(([name, value]) => [name, (value as string).trim()]),
  );
  return { ...derived, ...forwarded, VITE_OIDC_REDIRECT_URI: `${issuer}${webAppPrefix(app)}/` };
}

/** The script the browser loads before the bundle, carrying this environment's configuration. */
export function runtimeConfigScript(environment: Record<string, string>): string {
  return `globalThis.__LORB_ENV__=${JSON.stringify(environment)};\n`;
}

/**
 * Adds the configuration script to a built `index.html`.
 *
 * It goes first in the head so it runs before the bundle, which is a deferred module script. The
 * path is relative, so the same markup works whatever prefix the application is mounted at.
 */
export function injectRuntimeConfig(html: string): string {
  const tag = `<script src="./config.js"></script>`;
  if (html.includes("<head>")) return html.replace("<head>", `<head>${tag}`);
  return html.replace(/<script/i, `${tag}<script`);
}

/**
 * The policy one application is served under.
 *
 * `connect-src` and `frame-src` are built from configuration rather than widened to `*`: the portal
 * fetches this API and embeds the Player Shell in an iframe, and both of those origins are already
 * configured. `style-src` admits inline styles because React writes them as style attributes.
 */
export function webAppContentSecurityPolicy(config: RuntimeConfig): Record<string, string[]> {
  const issuerOrigin = new URL(config.publicIssuer).origin;
  const identityOrigins = [config.identity.issuer, config.identity.jwksUrl]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => { try { return new URL(value).origin; } catch { return undefined; } })
    .filter((value): value is string => value !== undefined);
  const connect = new Set(["'self'", issuerOrigin, config.playerOrigin, ...identityOrigins]);
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:"],
    fontSrc: ["'self'", "data:"],
    connectSrc: [...connect],
    // The portal opens a launch by embedding the Player Shell, which is a different origin by design.
    frameSrc: ["'self'", config.playerOrigin],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    objectSrc: ["'none'"],
  };
}

export interface WebAppMount {
  slug: string;
  prefix: string;
  root: string;
}

export interface WebAppRegistration {
  mounted: WebAppMount[];
  /** Applications that were asked for but whose bundle is not present. */
  missing: { slug: string; searched: string[] }[];
}

/**
 * Mounts every application whose bundle can be found, each in its own encapsulated scope so its
 * content security policy and static handler apply to it and to nothing else.
 *
 * A missing bundle is reported rather than thrown: the caller decides whether that is fatal, which
 * it is at start-up and is not in a test that only cares about one of the three.
 */
export async function registerWebApps(
  app: FastifyInstance,
  options: { config: RuntimeConfig; helmet?: typeof import("@fastify/helmet").default },
): Promise<WebAppRegistration> {
  const { config } = options;
  const helmet = options.helmet ?? (await import("@fastify/helmet")).default;
  const directives = webAppContentSecurityPolicy(config);
  const mounted: WebAppMount[] = [];
  const missing: { slug: string; searched: string[] }[] = [];

  for (const definition of WEB_APPS) {
    const root = resolveWebAppRoot(definition, config.topology.webAppsRoot);
    if (!root) {
      missing.push({ slug: definition.slug, searched: webAppRootCandidates(definition, config.topology.webAppsRoot) });
      continue;
    }
    const prefix = webAppPrefix(definition);
    const environment = webAppEnvironment(definition, config);
    const indexHtml = injectRuntimeConfig(readFileSync(join(root, "index.html"), "utf8"));
    const configScript = runtimeConfigScript(environment);
    const routeOptions = {
      helmet: { contentSecurityPolicy: { useDefaults: false, directives } },
    } as RouteShorthandOptions;

    await app.register(async (scope) => {
      // Without the trailing slash the browser resolves the bundle's relative asset URLs against the
      // parent path and asks this origin's root for them, so the page loads and renders nothing.
      scope.get(prefix, routeOptions, async (_req, reply) => reply.redirect(308, `${prefix}/`));
      const serveIndex = async (_req: unknown, reply: { header: (k: string, v: string) => { type: (t: string) => { send: (b: unknown) => unknown } } }) =>
        reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(indexHtml);
      scope.get(`${prefix}/`, routeOptions, serveIndex);
      scope.get(`${prefix}/index.html`, routeOptions, serveIndex);
      // No-store, because this is the one file that differs between two deployments of one image.
      scope.get(`${prefix}/config.js`, routeOptions, async (_req, reply) =>
        reply.header("cache-control", "no-store").type("text/javascript; charset=utf-8").send(configScript));
      await scope.register(fastifyStatic, {
        root,
        prefix: `${prefix}/`,
        // Asset file names carry a content hash, so they are safe to cache for a long time; the two
        // documents that are not hashed are served by the routes above with no-store.
        maxAge: "1y",
        immutable: true,
        index: false,
        redirect: false,
        // Only the first registration may add reply.sendFile, and there are three of these.
        decorateReply: false,
      });
    });
    mounted.push({ slug: definition.slug, prefix, root });
  }
  return { mounted, missing };
}
