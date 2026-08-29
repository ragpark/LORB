# Document player

Reusable native-web-package player for PowerPoint and Word files, presented as a page-by-page
image sequence. Like quiz-player, it contains **no document content** of its own — it renders a
structured JSON payload (`DocumentContent`, `packages/contracts`) fetched at runtime from
`GET /api/v1/runtime/learning-objects/:objectId/content`.

## Why images, not a PDF viewer

A `.pptx`/`.docx` file is never sent to the browser as-is, and this player never embeds a native
Office or PDF viewer plugin. Two reasons:

1. The module runs inside the same strictly sandboxed iframe as every other LORB player (see
   quiz-player's `App.tsx` for the full handshake rationale) — a sandbox that cannot reliably host a
   plugin-based viewer across browsers in the first place.
2. Keeping the render surface to "an array of image URLs" keeps this package in the same trust
   model as quiz-player: the player is reviewed once, and every document is *data* — pre-rendered
   pages — never a bundle or a live document-parsing surface.

The conversion from Office file to one image per page happens **offline**, before anything reaches
this player: see `packages/document-converter`. The original PDF, if the pipeline keeps one, is
offered only as an optional download link (`pdf_url`) — never as the render surface.

## Evidence

1. `launched` — once, on load.
2. `answered` — one per page-progress quartile reached (`result.response`: `p25`/`p50`/`p75`),
   reusing the existing verb rather than widening the Evidence API's accepted set.
3. `completed` — once, on reaching the last page.

## Known limitations

- Page progress only ever moves forward for evidence purposes (`furthestPage`), so flicking back to
  re-read an earlier page doesn't re-emit anything — matches how quiz-player treats answered
  questions.
- No text search, zoom-to-fit-width, or text selection, because pages are images. If that's needed
  later, the conversion step would need to ship page text alongside the image (e.g. an OCR or
  original-text overlay) rather than this player changing how it renders.
