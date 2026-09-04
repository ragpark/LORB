/**
 * Build-time configuration, overlaid with whatever the serving process injected at runtime.
 *
 * Vite substitutes `import.meta.env.VITE_*` with string literals when the bundle is built. That is
 * correct for a bundle built for one deployment and wrong for one artifact promoted through
 * several, which is what a container image is: the same bytes reach staging and production, and
 * baking an origin into them means rebuilding to move between environments.
 *
 * When the LORB app process serves this application it writes the environment's real values into
 * `globalThis.__LORB_ENV__` from a script tag ahead of this bundle, and those win. Served from its
 * own static origin with nothing injected, the build-time values are all there is and behaviour is
 * exactly what it was before this module existed.
 */
type InjectedEnv = Partial<Record<keyof ImportMetaEnv, string>>;
const injected = (globalThis as { __LORB_ENV__?: InjectedEnv }).__LORB_ENV__ ?? {};

export const webEnv: ImportMetaEnv = { ...import.meta.env, ...injected };
