/**
 * A minimal EPUB 3 reader core: unpack the archive, read the package document, walk the spine, and
 * turn one content document at a time into HTML the reader can render inline.
 *
 * Everything here runs inside the same sandboxed module iframe every LORB player uses, and that
 * decides the design. A content document is never loaded as a nested page — it is parsed, reduced
 * to its body, and stripped of every element that could execute or reach out (script, iframe,
 * object, form controls, media, external stylesheets) before it is handed to React as markup. What
 * survives is the book's text, structure, images from inside the archive (served to the DOM as blob
 * URLs), and its EDUPUB `epub:type` semantics, which the reader styles. Scripted EPUBs therefore run
 * nothing here; that is the point, not a limitation to fix later.
 */
import { strFromU8, unzipSync } from "fflate";

const NS_CONTAINER = "urn:oasis:names:tc:opendocument:xmlns:container";
const NS_OPF = "http://www.idpf.org/2007/opf";
const NS_DC = "http://purl.org/dc/elements/1.1/";
const NS_OPS = "http://www.idpf.org/2007/ops";
const NS_XLINK = "http://www.w3.org/1999/xlink";

/**
 * Bounds on what the reader will unpack. It runs on the learner's main thread inside the sandbox,
 * so a book is refused before it can exhaust the tab: the download itself, the number of entries,
 * and the cumulative declared size of what those entries expand to. Generous for a textbook with
 * images; nowhere near what a crafted archive needs to be a problem.
 */
export const LIMITS = {
  /** Compressed archive, as downloaded. */
  archiveBytes: 64 * 1024 * 1024,
  entries: 2000,
  /** Cumulative declared (uncompressed) size across all entries. */
  unpackedBytes: 256 * 1024 * 1024,
} as const;

export interface EpubChapter {
  id: string;
  /** Archive path of the content document, already resolved against the package document. */
  href: string;
  title: string;
}

export interface EpubTocEntry {
  label: string;
  href: string;
  /** Index into `chapters`, or undefined when the entry points somewhere off the spine. */
  chapterIndex?: number;
}

export interface EpubBook {
  title: string;
  creator?: string;
  language?: string;
  chapters: EpubChapter[];
  toc: EpubTocEntry[];
  /** Every archive entry, by path. */
  files: Record<string, Uint8Array>;
  mediaTypes: Record<string, string>;
}

export interface RenderedChapter {
  html: string;
  css: string;
  /** Releases the blob URLs minted for this chapter's images. Call when the chapter leaves the DOM. */
  revoke(): void;
}

/** Elements that can run, embed, submit, or fetch. Removed outright, children included. */
const DROPPED_ELEMENTS = new Set([
  "script", "iframe", "object", "embed", "applet", "form", "input", "button", "select", "textarea",
  "link", "meta", "base", "style", "template", "noscript", "audio", "video", "source", "track", "portal",
]);

/** Attributes that name a resource to fetch or a place to send something. On anything but the
 *  image elements and links handled specially below, an off-archive value is removed. */
const URL_ATTRIBUTES = new Set([
  "href", "xlink:href", "src", "srcset", "poster", "data", "background", "ping", "formaction", "action",
  "cite", "longdesc", "usemap", "manifest", "codebase", "archive",
]);

const hasScheme = (value: string): boolean => /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//");

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Resolves an href inside the archive: relative to `fromDir`, `..` collapsed, fragment/query dropped. */
export function resolveArchivePath(fromDir: string, href: string): string {
  const clean = href.split("#")[0]!.split("?")[0]!;
  const parts = (clean.startsWith("/") ? clean.slice(1) : `${fromDir ? `${fromDir}/` : ""}${clean}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return decodeURIComponent(out.join("/"));
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("The book contains a malformed XML document");
  return doc;
}

function parseContentDocument(text: string): Document {
  const xml = new DOMParser().parseFromString(text, "application/xhtml+xml");
  if (xml.getElementsByTagName("parsererror").length === 0) return xml;
  // Not well-formed XHTML — EPUB 3 requires it, but a lenient HTML parse still reads the text.
  return new DOMParser().parseFromString(text, "text/html");
}

function epubType(element: Element): string {
  return element.getAttributeNS(NS_OPS, "type") ?? element.getAttribute("epub:type") ?? "";
}

function firstByLocalName(root: ParentNode, ns: string | null, localName: string): Element | undefined {
  const byNs = ns ? (root as Document | Element).getElementsByTagNameNS?.(ns, localName) : undefined;
  if (byNs && byNs.length > 0) return byNs[0]!;
  return Array.from(root.querySelectorAll("*")).find((el) => el.localName === localName);
}

function allByLocalName(root: ParentNode, ns: string | null, localName: string): Element[] {
  const byNs = ns ? (root as Document | Element).getElementsByTagNameNS?.(ns, localName) : undefined;
  if (byNs && byNs.length > 0) return Array.from(byNs);
  return Array.from(root.querySelectorAll("*")).filter((el) => el.localName === localName);
}

/** Fetches and unpacks an EPUB, reading enough of its package document to drive the reader. */
export async function loadEpub(url: string): Promise<EpubBook> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The book could not be fetched (${response.status})`);
  const tooLarge = new Error("The book is larger than this reader will open");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > LIMITS.archiveBytes) throw tooLarge;
  // Read incrementally and stop at the bound: a server that omits Content-Length, or understates
  // it, must not get to hand the tab an arbitrarily large body before the size is ever checked.
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > LIMITS.archiveBytes) throw tooLarge;
    return openEpub(bytes);
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > LIMITS.archiveBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return openEpub(bytes);
}

/** Opens EPUB bytes already in hand — the part of loadEpub that needs no network. */
export function openEpub(bytes: Uint8Array): EpubBook {
  if (bytes.byteLength > LIMITS.archiveBytes) throw new Error("The book is larger than this reader will open");
  let files: Record<string, Uint8Array>;
  let entries = 0;
  let unpacked = 0;
  const tooBig = new Error("The book expands to more than this reader will open");
  try {
    files = unzipSync(bytes, {
      // Checked per entry, before that entry is inflated, against what the archive declares — so a
      // bomb is refused on its directory, not discovered after the allocation it was built to cause.
      filter: (entry) => {
        entries += 1;
        unpacked += entry.originalSize;
        if (entries > LIMITS.entries || unpacked > LIMITS.unpackedBytes) throw tooBig;
        return true;
      },
    });
  } catch (error) {
    if (error === tooBig) throw error;
    throw new Error("The file is not a readable EPUB archive");
  }
  const mimetype = files["mimetype"] ? strFromU8(files["mimetype"]).trim() : "";
  if (mimetype !== "application/epub+zip") throw new Error("The file is not an EPUB (missing or wrong mimetype entry)");

  const containerText = files["META-INF/container.xml"];
  if (!containerText) throw new Error("The EPUB has no META-INF/container.xml");
  const container = parseXml(strFromU8(containerText));
  const rootfile = firstByLocalName(container, NS_CONTAINER, "rootfile")?.getAttribute("full-path");
  if (!rootfile || !files[rootfile]) throw new Error("The EPUB's container names no package document");

  const opf = parseXml(strFromU8(files[rootfile]!));
  const opfDir = dirnameOf(rootfile);
  const textOf = (ns: string, name: string) => firstByLocalName(opf, ns, name)?.textContent?.trim() || undefined;
  const title = textOf(NS_DC, "title") ?? "Untitled book";
  const creator = textOf(NS_DC, "creator");
  const language = textOf(NS_DC, "language");

  const manifest = new Map<string, { href: string; mediaType: string; properties: string[] }>();
  const mediaTypes: Record<string, string> = {};
  for (const item of allByLocalName(opf, NS_OPF, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    const resolved = resolveArchivePath(opfDir, href);
    const mediaType = item.getAttribute("media-type") ?? "application/octet-stream";
    manifest.set(id, { href: resolved, mediaType, properties: (item.getAttribute("properties") ?? "").split(/\s+/).filter(Boolean) });
    mediaTypes[resolved] = mediaType;
  }

  const chapters: EpubChapter[] = [];
  for (const itemref of allByLocalName(opf, NS_OPF, "itemref")) {
    const idref = itemref.getAttribute("idref");
    const item = idref ? manifest.get(idref) : undefined;
    if (!idref || !item) continue;
    if ((itemref.getAttribute("linear") ?? "yes") === "no") continue;
    if (!files[item.href]) continue;
    chapters.push({ id: idref, href: item.href, title: "" });
  }
  if (chapters.length === 0) throw new Error("The EPUB's spine lists no readable content documents");

  const toc: EpubTocEntry[] = [];
  const navItem = Array.from(manifest.values()).find((item) => item.properties.includes("nav"));
  if (navItem && files[navItem.href]) {
    const navDoc = parseContentDocument(strFromU8(files[navItem.href]!));
    const navDir = dirnameOf(navItem.href);
    const tocNav = Array.from(navDoc.querySelectorAll("nav")).find((nav) => epubType(nav).split(/\s+/).includes("toc"));
    for (const anchor of tocNav ? Array.from(tocNav.querySelectorAll("a[href]")) : []) {
      const href = resolveArchivePath(navDir, anchor.getAttribute("href") ?? "");
      const chapterIndex = chapters.findIndex((chapter) => chapter.href === href);
      toc.push({ label: anchor.textContent?.trim() || href, href, ...(chapterIndex >= 0 ? { chapterIndex } : {}) });
    }
  }

  // A chapter's title comes from the table of contents where it has an entry, otherwise from the
  // content document's own <title>, otherwise its position.
  chapters.forEach((chapter, index) => {
    const entry = toc.find((candidate) => candidate.chapterIndex === index);
    if (entry) { chapter.title = entry.label; return; }
    const doc = parseContentDocument(strFromU8(files[chapter.href]!));
    chapter.title = doc.querySelector("title")?.textContent?.trim() || `Page ${index + 1}`;
  });

  return { title, creator, language, chapters, toc, files, mediaTypes };
}

/**
 * A book's CSS, made safe to inject.
 *
 * Text-level rewriting is not enough here: CSS has more than one way to name a resource
 * (`image-set("…")`, an escaped function name like `u\72l(…)`, a `var()` carrying either), and the
 * sandbox does not stop the fetch such a declaration causes once it is rendered. So the browser's own
 * parser does the reading. The stylesheet is parsed into a constructed CSSStyleSheet — which fetches
 * nothing, is never adopted, and drops @import — and rebuilt declaration by declaration from the
 * parser's canonical serialisation, in which every resource reference is a plain `url("…")` and
 * function names carry no escapes. Each `url()` is then rewritten (in-archive → blob URL, fragment
 * kept, anything else → `none`), and a declaration that still carries anything that could resolve
 * outside the archive — a remaining non-blob `url()`, a `//`, a `var()` or custom property that could
 * smuggle one, a backslash escape — is dropped whole. Only style rules and @media/@supports blocks
 * survive; everything else (@font-face, @import, @namespace, @property, …) is discarded.
 *
 * Scoping uses CSS nesting: the rebuilt rules are wrapped in `scope { … }`, so a selector list is
 * never split by hand, and `html`/`body` selectors become the scope itself.
 */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;

function rewriteUrls(value: string, fromDir: string, blobFor: (path: string) => string | undefined): string {
  return value.replace(CSS_URL, (_match, dq?: string, sq?: string, bare?: string) => {
    const target = (dq ?? sq ?? bare ?? "").trim();
    if (target.startsWith("#")) return `url("${target.replace(/"/g, "")}")`;
    if (!target || hasScheme(target)) return "none";
    const url = blobFor(resolveArchivePath(fromDir, target));
    return url ? `url("${url}")` : "none";
  });
}

/** A declaration value, after rewriting, is kept only if nothing in it could still name a resource
 *  outside the archive. Conservative on purpose: a dropped declaration costs a book some styling,
 *  a kept one could cost a learner a beacon. */
function valueIsContained(value: string): boolean {
  if (/\\/.test(value)) return false;
  if (/var\(/i.test(value)) return false;
  if (/\/\//.test(value)) return false;
  const urls = Array.from(value.matchAll(CSS_URL)).map((m) => (m[1] ?? m[2] ?? m[3] ?? "").trim());
  if (urls.some((target) => !(target.startsWith("blob:") || target.startsWith("#")))) return false;
  // Any other function that takes a resource or a string the parser did not fold into url().
  if (/(?:^|[^a-z-])(?:image-set|-webkit-image-set|src|element|-moz-element|paint|image|cross-fade|-webkit-cross-fade)\s*\(/i.test(value)) return false;
  return true;
}

function sanitizeDeclarations(style: CSSStyleDeclaration, fromDir: string, blobFor: (path: string) => string | undefined): string {
  const out: string[] = [];
  for (let i = 0; i < style.length; i += 1) {
    const property = style.item(i);
    if (!property || property.startsWith("--")) continue;
    const rewritten = rewriteUrls(style.getPropertyValue(property), fromDir, blobFor);
    if (!valueIsContained(rewritten)) continue;
    const priority = style.getPropertyPriority(property);
    out.push(`${property}:${rewritten}${priority ? ` !${priority}` : ""}`);
  }
  return out.join(";");
}

function sanitizeRules(rules: CSSRuleList, fromDir: string, blobFor: (path: string) => string | undefined): string {
  let out = "";
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const selector = rule.selectorText.split(",").map((part) => part.trim()).map((part) => (/^(html|body)$/i.test(part) ? "&" : part.replace(/^(html|body)\s+/i, ""))).join(",");
      const body = sanitizeDeclarations(rule.style, fromDir, blobFor);
      if (body) out += `${selector}{${body}}`;
    } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
      const inner = sanitizeRules(rule.cssRules, fromDir, blobFor);
      const keyword = rule instanceof CSSMediaRule ? "@media" : "@supports";
      if (inner) out += `${keyword} ${rule.conditionText}{${inner}}`;
    }
    // Every other rule kind is discarded.
  }
  return out;
}

/** A stylesheet from the archive (or an embedded <style>), sanitised and scoped under `scope`. */
export function sanitizeStylesheet(css: string, fromDir: string, blobFor: (path: string) => string | undefined, scope: string): string {
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return "";
  }
  const rules = sanitizeRules(sheet.cssRules, fromDir, blobFor);
  return rules ? `${scope}{${rules}}` : "";
}

/** A `style` attribute's value, sanitised the same way. Parsed on a detached element, so no
 *  resource it names is fetched while it is being read. */
export function sanitizeStyleAttribute(value: string, fromDir: string, blobFor: (path: string) => string | undefined): string {
  const probe = document.createElement("span");
  probe.setAttribute("style", value);
  return sanitizeDeclarations(probe.style, fromDir, blobFor);
}

/** Renders one spine item to scoped CSS plus sanitised HTML. */
export function renderChapter(book: EpubBook, chapterIndex: number, scope: string): RenderedChapter {
  const chapter = book.chapters[chapterIndex];
  if (!chapter) throw new Error("No such page");
  const doc = parseContentDocument(strFromU8(book.files[chapter.href]!));
  const chapterDir = dirnameOf(chapter.href);
  const blobUrls: string[] = [];

  const blobFor = (path: string): string | undefined => {
    const data = book.files[path];
    if (!data) return undefined;
    // Copied into a fresh buffer: fflate's views may share one backing store, and Blob wants an owned one.
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: book.mediaTypes[path] ?? "application/octet-stream" }));
    blobUrls.push(url);
    return url;
  };

  // Stylesheets the document links to from inside the archive, plus its own <style> blocks — each
  // parsed, sanitised and scoped (see sanitizeStylesheet), with url() references resolved relative
  // to where that stylesheet lives.
  const cssParts: string[] = [];
  for (const link of Array.from(doc.querySelectorAll("link"))) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) continue;
    const href = link.getAttribute("href");
    if (!href || hasScheme(href)) continue;
    const path = resolveArchivePath(chapterDir, href);
    const data = book.files[path];
    if (data) cssParts.push(sanitizeStylesheet(strFromU8(data), dirnameOf(path), blobFor, scope));
  }
  for (const style of Array.from(doc.querySelectorAll("style"))) cssParts.push(sanitizeStylesheet(style.textContent ?? "", chapterDir, blobFor, scope));

  const body = doc.querySelector("body") ?? doc.documentElement;
  const container = document.createElement("div");
  for (const child of Array.from(body.childNodes)) container.appendChild(document.importNode(child, true));

  for (const element of Array.from(container.querySelectorAll("*"))) {
    const name = element.localName.toLowerCase();
    if (DROPPED_ELEMENTS.has(name)) { element.remove(); continue; }
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (attributeName.startsWith("on")) { element.removeAttribute(attribute.name); continue; }
      if (attributeName === "style") {
        const safe = sanitizeStyleAttribute(value, chapterDir, blobFor);
        if (safe) element.setAttribute("style", safe); else element.removeAttribute("style");
        continue;
      }
      if (!URL_ATTRIBUTES.has(attributeName)) continue;
      if (/^\s*(javascript|data|vbscript|blob):/i.test(value)) { element.removeAttribute(attribute.name); continue; }
      // Image elements and links are resolved below; anything else pointing off the archive goes.
      const handledBelow = (name === "img" || name === "image") && (attributeName === "src" || attributeName === "href" || attributeName === "xlink:href");
      if (name === "a" && attributeName === "href") continue;
      if (!handledBelow && (hasScheme(value) || attributeName === "srcset")) element.removeAttribute(attribute.name);
    }
    if (name === "img" || name === "image") {
      const source = element.getAttribute("src") ?? element.getAttributeNS(NS_XLINK, "href") ?? element.getAttribute("href");
      element.removeAttribute("srcset");
      const resolved = source && !/^[a-z][a-z\d+.-]*:/i.test(source) ? blobFor(resolveArchivePath(chapterDir, source)) : undefined;
      if (resolved) {
        if (name === "img") element.setAttribute("src", resolved);
        else { element.setAttributeNS(NS_XLINK, "xlink:href", resolved); element.setAttribute("href", resolved); }
      } else {
        // Anything outside the archive is not fetched: an <img> with no source shows its alt text.
        element.removeAttribute("src");
        element.removeAttribute("href");
        element.removeAttributeNS(NS_XLINK, "href");
      }
    }
    if (name === "a") {
      const href = element.getAttribute("href");
      if (!href) continue;
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) {
        // Off-archive links: the sandbox has no allow-popups and a same-frame navigation would end
        // the launch, so the destination is shown as text the learner can copy, never followed.
        element.setAttribute("data-epub-external", href);
        element.removeAttribute("href");
        element.setAttribute("role", "link");
        element.setAttribute("title", `External link (not followed inside the reader): ${href}`);
        continue;
      }
      const fragment = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
      const target = href.startsWith("#") ? chapter.href : resolveArchivePath(chapterDir, href);
      const targetIndex = book.chapters.findIndex((candidate) => candidate.href === target);
      element.setAttribute("href", `#${fragment}`);
      if (targetIndex >= 0) element.setAttribute("data-epub-chapter", String(targetIndex));
      if (fragment) element.setAttribute("data-epub-fragment", fragment);
    }
  }

  return {
    html: container.innerHTML,
    css: cssParts.join("\n"),
    revoke: () => { for (const url of blobUrls) URL.revokeObjectURL(url); },
  };
}
