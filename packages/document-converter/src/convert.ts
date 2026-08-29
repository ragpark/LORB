/**
 * Office-file-to-page-images conversion.
 *
 * The document-player never receives a native .pptx/.docx file, and never embeds a native Office or
 * PDF viewer — see packages/document-player/README.md for why. This module is the offline step that
 * makes that possible: it shells out to a headless LibreOffice to get a PDF (the one format
 * conversion LibreOffice does reliably and losslessly enough for a formative learning resource), then
 * to Poppler's pdftoppm to rasterise each page to a PNG.
 *
 * Both binaries are external processes, not npm packages, because there is no maintained pure-JS
 * renderer for .pptx/.docx with acceptable layout fidelity. See the Dockerfile in this package for
 * what has to be installed alongside Node for this to run.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const SOURCE_EXTENSION: Record<"pptx" | "ppt" | "docx" | "doc", string> = {
  pptx: "pptx", ppt: "ppt", docx: "docx", doc: "doc",
};

export interface ConversionResult {
  /** The rendered PDF, kept only as an optional original-fidelity download — never the render surface. */
  pdf: Buffer;
  /** One PNG per page, in reading order, starting at page 1. */
  pages: Buffer[];
}

export interface ConvertOptions {
  /** Rasterisation resolution. 150 keeps a typical slide under ~250KB; raise for dense text documents. */
  dpi?: number;
  /** Wall-clock budget for the LibreOffice conversion step, which is the slow, occasionally-hanging part. */
  timeoutMs?: number;
}

/**
 * Converts one Office file's bytes to a PDF and a page-image sequence.
 *
 * Runs entirely against a scratch directory that is always removed, including on failure — a
 * conversion failure must not leave a temp file lying around that a later, unrelated conversion could
 * collide with or accidentally pick up.
 */
export async function convertToPageImages(
  sourceFormat: keyof typeof SOURCE_EXTENSION,
  fileBytes: Buffer,
  options: ConvertOptions = {},
): Promise<ConversionResult> {
  const dpi = options.dpi ?? 150;
  const timeout = options.timeoutMs ?? 120_000;
  const workDir = await mkdtemp(join(tmpdir(), "lorb-doc-convert-"));
  try {
    const inputPath = join(workDir, `source.${SOURCE_EXTENSION[sourceFormat]}`);
    await writeFile(inputPath, fileBytes);

    // LibreOffice writes <basename>.pdf into --outdir using the input's basename, with no way to name
    // it directly — so the output path is derived rather than chosen.
    await run("soffice", [
      "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nofirststartwizard",
      "--convert-to", "pdf", "--outdir", workDir, inputPath,
    ], { timeout });
    const pdfPath = join(workDir, "source.pdf");
    const pdf = await readFile(pdfPath);

    const pageStem = join(workDir, "page");
    await run("pdftoppm", ["-png", "-r", String(dpi), pdfPath, pageStem], { timeout });
    const files = (await readdir(workDir)).filter((name) => name.startsWith("page") && name.endsWith(".png")).sort();
    const pages = await Promise.all(files.map((name) => readFile(join(workDir, name))));
    if (pages.length === 0) throw new Error("Conversion produced a PDF with no renderable pages");

    return { pdf, pages };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** A locally-unique, collision-free id for naming a conversion's output files on disk. */
export const newConversionId = (): string => randomUUID();

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
