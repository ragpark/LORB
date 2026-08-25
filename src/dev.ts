/**
 * Local development entry point.
 *
 * Runs the same host as production, with the development conveniences configuration allows outside
 * it: an ephemeral signing key when none is configured, the in-process store when no database is
 * reachable, and the bundled example catalogue. Every one of those is refused when NODE_ENV is
 * production or staging, so this file is a shortcut rather than a second code path.
 */
process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "debug";
process.env.SEED_EXAMPLE_CONTENT ??= "true";
process.env.ALLOW_SYNTHETIC_IDENTITY ??= "true";

await import("./server.js");
