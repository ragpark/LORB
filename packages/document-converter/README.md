# Document converter

Turns an uploaded PowerPoint or Word file into the page-image sequence `document-player` renders.
Not part of the runtime API's process — a separate service, because it shells out to LibreOffice and
Poppler, which the runtime container doesn't (and shouldn't) carry.

## Pipeline

1. `POST /convert` — base64 file bytes in, JSON out (see below). Internally: LibreOffice headless
   (`soffice --convert-to pdf`) renders the file to a PDF; Poppler's `pdftoppm` rasterises each PDF
   page to a PNG.
2. The PDF is discarded unless `keep_pdf: true` is set. The player never renders it — see
   `packages/document-player/README.md` — so keeping it is purely for an optional "download original"
   link, and doubles the disk this service holds per document.
3. The response is shaped exactly like `DocumentDraft` (`packages/contracts`), nested under `draft`,
   so a caller can pass it straight through to `POST /api/v1/internal/runtime/documents` to register
   it as a learning object.

```
POST /convert
{
  "title": "Week 3 slides",
  "source_format": "pptx",
  "filename": "week-3.pptx",
  "content_base64": "<base64>",
  "keep_pdf": false
}

201
{
  "conversion_id": "…",
  "page_count": 14,
  "draft": {
    "title": "Week 3 slides",
    "source_format": "pptx",
    "pages": [{ "index": 0, "image_url": "https://…/files/…/page-0000.png" }, …]
  }
}
```

## Storage is deliberately temporary

Converted pages are served from this service's own local disk under `/files/:conversionId/...` —
there is no S3/GCS integration here, because none exists elsewhere in this repo either (every other
package serves fixed, build-time static assets rather than user-uploaded ones). A production
deployment should treat this service's output as transient: fetch the page URLs once, right after
conversion, and re-host them behind whatever object storage the deployment actually uses, before
calling `registerMedia`. Restarting this service's container without a persistent volume loses every
conversion's output.

## Known limitations

- **Fidelity is "good enough for a formative slide deck", not "identical to PowerPoint".** Headless
  LibreOffice's rendering of complex PowerPoint animations, embedded video, and some font
  substitutions differs from PowerPoint's own renderer. Acceptable for a page-by-page reading
  experience; not a guarantee of pixel-perfect reproduction.
- **No virus/malware scanning of the uploaded file.** This service trusts its caller (the internal
  MCP-connector surface) the same way `internal/quizzes.ts` and `internal/media.ts` do; it is not
  designed to accept files directly from a learner or an unauthenticated caller.
- **No retry or queueing.** A conversion is a single synchronous HTTP request bounded by
  `timeoutMs` (120s default). A very large deck may need that raised, or this endpoint moved behind a
  job queue — not attempted here to keep this a first, working version.
- `fonts-dejavu`/`fonts-liberation` are installed so common Office fonts substitute reasonably, but
  a deck using a licensed corporate font will still substitute to something else.
