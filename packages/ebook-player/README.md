# Ebook player

Reusable native-web-package reader for **EPUB 3** publications — educational books in the EDUPUB
sense. Like quiz-player and document-player it contains no book of its own: it renders the
`EbookContent` payload (`packages/contracts`) fetched at runtime from
`GET /api/v1/runtime/learning-objects/:objectId/content`, whose `epub_url` names the book file.

## How a book is rendered — and why not with a nested page

The reader runs inside the same strictly sandboxed module iframe as every other LORB player, and
that sandbox has no `allow-same-origin`. Loading a content document as a nested page there would
either fail or need permissions this player deliberately doesn't request, so the reader does not.
Instead (`src/epub.ts`):

1. The archive is fetched and unpacked in the browser (`fflate`).
2. `META-INF/container.xml` names the package document; its manifest, spine and `nav` document
   give the reading order, the table of contents and the display metadata.
3. One spine item at a time is parsed as XHTML, reduced to its `<body>`, and **stripped of every
   element that could run or reach out**: `script`, `iframe`, `object`, `embed`, form controls,
   `audio`/`video`, `link`, `meta`, `base`, `style`-in-body, `on*` attributes, and `javascript:` /
   `data:` URLs. What survives is text, structure, images from inside the archive (handed to the DOM
   as blob URLs) and the `epub:type` semantics.
4. The book's own stylesheets (linked, embedded, and `style` attributes) are scoped under the
   reading pane before they are applied, so a book can style its pages and nothing of the reader
   around them — and every `url()` in them is rewritten: an in-archive target becomes a blob URL,
   anything else becomes `none`. CSS is the one place a book could otherwise reach the network
   (a `background: url(https://…)` beacon), so that rewrite is part of the boundary, not a nicety.
   `@font-face` and `@import` are dropped.
5. Bounds are enforced before anything is inflated (`LIMITS` in `src/epub.ts`): the download
   (64 MiB), the entry count (2,000) and the cumulative declared unpacked size (256 MiB). A book past
   any of them is refused with an error rather than allowed to exhaust the tab.

Scripted EPUBs therefore run nothing here. That is the trust model, not a gap: the reader is the
code that was reviewed; every book is data it displays.

## EDUPUB semantics

The reader styles the EDUPUB / EPUB Structural Semantics vocabulary a book may carry via
`epub:type`: `learning-objectives` / `learning-objective`, `learning-outcomes` / `learning-outcome`,
`keyword`, `sidebar` / `note`, `practice`, `assessment` with `question` and revealable `answer`
(a `<details>` element, which needs no script). A book that styles these itself wins, since its
stylesheet is applied after the reader's.

## Where the book file lives

`epub_url` is either an https URL the learner's browser can fetch with CORS, or a `/modules/…` path
on the Player Shell origin — the reader resolves it against its own location. The bundled exemplar,
*Photosynthesis: how plants make food* (three pages, built from `exemplar/` by
`scripts/build-exemplar.mjs` into `public/exemplar/` at build time), is addressed that way:
`/modules/ebook-player/exemplar/photosynthesis-reader.epub`. The catalogue seeds it into the default
repository wherever `SEED_EXAMPLE_CONTENT` is on.

## Evidence

Mirrors document-player one for one, reusing the existing verbs rather than widening the Evidence
API's accepted set:

1. `launched` — once, when the book has been opened.
2. `answered` — one per quartile of the spine reached (`result.response`: `p25`/`p50`/`p75`).
3. `completed` — once, on reaching the last spine item.

## Known limitations

- Reflowable content only: fixed-layout (`rendition:layout: pre-paginated`) books are rendered as
  ordinary flowing pages.
- Embedded fonts, audio, video and scripted interactivity inside a book are not rendered (see the
  trust model above). Media overlays are ignored.
- External links are shown as text and never followed, because the sandbox has no `allow-popups`
  and a same-frame navigation would end the launch.
- Progress only moves forward for evidence purposes (furthest spine item reached), same as
  document-player.
