/** Types for build-exemplar.mjs, which stays plain JavaScript because `pnpm build` runs it with node. */
export const EXEMPLAR_DIR: string;
export const EXEMPLAR_FILE_NAME: string;
export const OUTPUT_PATH: string;
export function buildExemplar(): Uint8Array;
export function packEpub(entries: Record<string, string>): Uint8Array;
export function entriesOf(bytes: Uint8Array): Record<string, string>;
