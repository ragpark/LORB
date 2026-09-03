/**
 * Packs exemplar/ into a valid EPUB 3 archive at public/exemplar/photosynthesis-reader.epub, which
 * `vite build` then copies into dist/ beside the reader, so Dockerfile.player-shell serves it at
 * /modules/ebook-player/exemplar/photosynthesis-reader.epub — the path the catalogue seed names.
 *
 * Two EPUB packaging rules are enforced here rather than trusted to a generic zip tool: the
 * `mimetype` entry must be the first file in the archive and must be stored uncompressed, so a reader
 * can sniff the container from its first bytes. Everything else is deflated. Timestamps are fixed so
 * the archive is byte-for-byte reproducible from the same sources.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
export const EXEMPLAR_DIR = resolve(here, "../exemplar");
export const EXEMPLAR_FILE_NAME = "photosynthesis-reader.epub";
export const OUTPUT_PATH = resolve(here, "../public/exemplar", EXEMPLAR_FILE_NAME);
const FIXED_MTIME = new Date("2026-09-01T09:00:00Z");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** The exemplar as EPUB bytes. */
export function buildExemplar() {
  const files = walk(EXEMPLAR_DIR).map((full) => relative(EXEMPLAR_DIR, full).split("\\").join("/"));
  if (!files.includes("mimetype")) throw new Error("exemplar/mimetype is missing");
  const entries = {};
  entries["mimetype"] = [new Uint8Array(readFileSync(join(EXEMPLAR_DIR, "mimetype"))), { level: 0, mtime: FIXED_MTIME }];
  for (const file of files) {
    if (file === "mimetype") continue;
    entries[file] = [new Uint8Array(readFileSync(join(EXEMPLAR_DIR, file))), { level: 6, mtime: FIXED_MTIME }];
  }
  return zipSync(entries);
}

/** Packs `entries` (archive path → text) as an EPUB: mimetype first and stored, the rest deflated.
 *  For tests that need a small purpose-built book rather than the exemplar. */
export function packEpub(entries) {
  const packed = { "mimetype": [strToU8("application/epub+zip"), { level: 0, mtime: FIXED_MTIME }] };
  for (const [name, text] of Object.entries(entries)) {
    if (name === "mimetype") continue;
    packed[name] = [strToU8(text), { level: 6, mtime: FIXED_MTIME }];
  }
  return zipSync(packed);
}

/** The archive's entries, decoded — for tests that check the package without a browser. */
export function entriesOf(bytes) {
  const unpacked = unzipSync(bytes);
  return Object.fromEntries(Object.entries(unpacked).map(([name, data]) => [name, strFromU8(data)]));
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const bytes = buildExemplar();
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, bytes);
  console.log(`wrote ${relative(process.cwd(), OUTPUT_PATH)} (${bytes.length} bytes)`);
}
