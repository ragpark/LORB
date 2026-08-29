/**
 * HTTP front for the document converter.
 *
 * POST /convert takes an Office file (base64, to keep this service dependency-free of a multipart
 * parser) and returns a body shaped exactly like `DocumentDraft` (packages/contracts) — title,
 * source_format, one image_url per page, optionally pdf_url — ready to POST straight through to the
 * runtime's `POST /api/v1/internal/runtime/documents`. This service never registers the object
 * itself: converting a file and deciding it should become a learning object are different
 * decisions, made by different callers, same as every other internal content-registration route in
 * this repo.
 *
 * Rendered pages and the optional PDF are hosted by this same service under /files/:conversionId/...
 * for as long as its local disk keeps them — that is deliberately temporary storage, not a
 * durability guarantee. A production deployment should have its caller (the MCP connector, or
 * whatever authored the content) fetch these URLs once and re-host them behind the runtime's own
 * object storage before the content is registered; this service does not assume one exists.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { convertToPageImages, ensureDir } from "./convert.js";

const DATA_DIR = process.env.DOCUMENT_CONVERTER_DATA_DIR ?? "/app/data";
const PUBLIC_BASE_URL = process.env.DOCUMENT_CONVERTER_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 5100}`;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB: generous for a slide deck, small enough to bound memory use of a base64 body

const convertRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(600).optional(),
  source_format: z.enum(["pptx", "ppt", "docx", "doc"]),
  filename: z.string().min(1).max(255),
  content_base64: z.string().min(1),
  /** Whether to also host the original PDF for download. Off by default: it is extra disk, and the
   * player never uses it for rendering — see packages/document-player/README.md. */
  keep_pdf: z.boolean().optional(),
}).strict();

const app = Fastify({ logger: true, bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4) }); // base64 overhead

app.get("/health", async () => ({ status: "ok" }));

app.get("/files/:conversionId/:filename", async (req, reply) => {
  const { conversionId, filename } = req.params as { conversionId: string; filename: string };
  // Reject anything that isn't a bare filename this service itself generated — no path traversal,
  // no reaching outside this conversion's own directory.
  if (!/^[a-z0-9-]+$/i.test(conversionId) || !/^[a-z0-9._-]+$/i.test(filename)) {
    return reply.code(400).send({ error: "INVALID_PATH" });
  }
  const path = join(DATA_DIR, conversionId, filename);
  try {
    const body = await readFile(path);
    const contentType = filename.endsWith(".pdf") ? "application/pdf" : "image/png";
    return reply.header("content-type", contentType).header("cache-control", "public, max-age=31536000, immutable").send(body);
  } catch {
    return reply.code(404).send({ error: "NOT_FOUND" });
  }
});

app.post("/convert", async (req, reply) => {
  const parsed = convertRequestSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST", detail: parsed.error.flatten() });
  const input = parsed.data;

  const bytes = Buffer.from(input.content_base64, "base64");
  if (bytes.byteLength === 0) return reply.code(400).send({ error: "EMPTY_FILE" });
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return reply.code(413).send({ error: "FILE_TOO_LARGE", max_bytes: MAX_UPLOAD_BYTES });

  const conversionId = randomUUID();
  const outDir = join(DATA_DIR, conversionId);

  try {
    const result = await convertToPageImages(input.source_format, bytes);
    await ensureDir(outDir);

    await Promise.all(result.pages.map((page, index) =>
      writeFile(join(outDir, `page-${String(index).padStart(4, "0")}.png`), page),
    ));
    if (input.keep_pdf) await writeFile(join(outDir, "document.pdf"), result.pdf);

    const draft = {
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      source_format: input.source_format,
      pages: result.pages.map((_, index) => ({
        index,
        image_url: `${PUBLIC_BASE_URL}/files/${conversionId}/page-${String(index).padStart(4, "0")}.png`,
      })),
      ...(input.keep_pdf ? { pdf_url: `${PUBLIC_BASE_URL}/files/${conversionId}/document.pdf` } : {}),
    };
    return reply.code(201).send({ conversion_id: conversionId, page_count: result.pages.length, draft });
  } catch (error) {
    req.log.error({ err: error, conversionId }, "document conversion failed");
    return reply.code(502).send({ error: "CONVERSION_FAILED", detail: error instanceof Error ? error.message : String(error) });
  }
});

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 5100) });
