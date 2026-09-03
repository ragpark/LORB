import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EbookContent, LaunchContext } from "../../contracts/src/index.js";
import { loadEpub, renderChapter, type EpubBook, type RenderedChapter } from "./epub.js";
import { completedStatement, launchedStatement, progressStatement, quartilesCrossed, type ShellContext, type XapiStatement } from "./statements.js";

/** Handshake with the Player Shell — identical to quiz-player/src/App.tsx; see that file for the
 * full rationale. Duplicated per-package by existing repo convention (document-player does too). */
function shellTarget(): string {
  return document.referrer ? new URL(document.referrer).origin : "*";
}

function handshakeNonce(): string | undefined {
  return /(?:^#|&)lorb_handshake=([^&]+)/.exec(location.hash)?.[1];
}

function envelope(type: string, payload: Record<string, unknown>, correlationId?: string) {
  return {
    protocol: "lorb-player",
    version: "1.0",
    type,
    message_id: crypto.randomUUID(),
    correlation_id: correlationId ?? crypto.randomUUID(),
    reply_to: null,
    sent_at: new Date().toISOString(),
    payload,
  };
}

function connectToShell(onContext: (context: ShellContext, port: MessagePort) => void): () => void {
  const origin = shellTarget();
  const nonce = handshakeNonce();
  if (!nonce) return () => undefined;
  const channel = new MessageChannel();
  const port = channel.port1;
  port.onmessage = (event: MessageEvent) => {
    const data = event.data as { protocol?: string; type?: string; payload?: ShellContext } | null;
    if (!data || data.protocol !== "lorb-player" || data.type !== "shell.context" || !data.payload) return;
    onContext(data.payload, port);
  };
  port.start();
  parent.postMessage(envelope("module.hello", { lorb_handshake: nonce }), origin, [channel.port2]);
  return () => port.close();
}

type Phase = "waiting" | "loading" | "reading" | "completed" | "error";
type DeliveredContent = EbookContent & { launch_context?: LaunchContext };

interface Palette { page: string; ink: string; muted: string; card: string; border: string; accent: string; accentInk: string; soft: string; error: string }
const PALETTES: Record<string, Palette> = {
  "default": { page: "#fbfaf7", ink: "#1f2933", muted: "#52606d", card: "#ffffff", border: "#d9dee3", accent: "#3b5b92", accentInk: "#ffffff", soft: "#eef2f8", error: "#b91c1c" },
  "midnight": { page: "#101725", ink: "#e5eaf1", muted: "#9aa7b8", card: "#1a2333", border: "#2c3a52", accent: "#7aa2e8", accentInk: "#101725", soft: "#202c40", error: "#f2a1a1" },
  "high-contrast": { page: "#ffffff", ink: "#000000", muted: "#1a1a1a", card: "#ffffff", border: "#000000", accent: "#000000", accentInk: "#ffffff", soft: "#f2f2f2", error: "#a00000" },
};
const paletteFor = (theme: string | undefined): Palette => PALETTES[theme ?? "default"] ?? PALETTES["default"]!;

/** The class every book stylesheet is scoped under, and the reader's own EDUPUB styling hangs off. */
const SCOPE = ".epub-body";

/** Where the book file lives: an https URL as given, or a /modules/… path on this reader's own
 * origin — the Player Shell serves both the reader and any bundled book from the same host. */
function resolveBookUrl(epubUrl: string): string {
  return new URL(epubUrl, location.href).toString();
}

export function App() {
  const [context, setContext] = useState<ShellContext>();
  const [port, setPort] = useState<MessagePort>();
  const [content, setContent] = useState<DeliveredContent>();
  const [book, setBook] = useState<EpubBook>();
  const [chapterIndex, setChapterIndex] = useState(0);
  const [rendered, setRendered] = useState<RenderedChapter>();
  const [contentsOpen, setContentsOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [message, setMessage] = useState("");
  const [emitted, setEmitted] = useState<XapiStatement[]>([]);
  const furthestChapter = useRef(0);
  const readingPane = useRef<HTMLDivElement>(null);

  useEffect(() => connectToShell((received, openPort) => {
    setContext(received);
    setPort(openPort);
  }), []);

  useEffect(() => {
    if (!context?.content_url || !port) return;
    let cancelled = false;
    setPhase("loading");
    void fetch(context.content_url, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`Content request failed (${response.status})`))))
      .then(async (body: DeliveredContent) => {
        if (cancelled) return;
        setContent(body);
        const opened = await loadEpub(resolveBookUrl(body.epub_url));
        if (cancelled) return;
        setBook(opened);
        setPhase("reading");
        const statement = launchedStatement(context, () => crypto.randomUUID());
        port.postMessage(envelope("evidence.emit", { statement }, context.correlation_id));
        setEmitted([statement]);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setPhase("error");
        setMessage(error.message);
        port.postMessage(envelope("experience.error", { code: "EBOOK_CONTENT_UNAVAILABLE", recoverable: false, detail: error.message }, context.correlation_id));
      });
    return () => { cancelled = true; };
  }, [context, port]);

  // Render the current spine item; release its blob URLs when it leaves.
  useEffect(() => {
    if (!book) return;
    let current: RenderedChapter | undefined;
    try {
      current = renderChapter(book, chapterIndex, SCOPE);
      setRendered(current);
      readingPane.current?.scrollTo({ top: 0 });
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "This page could not be displayed");
    }
    return () => current?.revoke();
  }, [book, chapterIndex]);

  const emit = useCallback((statement: XapiStatement) => {
    if (!context || !port) return;
    port.postMessage(envelope("evidence.emit", { statement }, context.correlation_id));
    setEmitted((previous) => [...previous, statement]);
  }, [context, port]);

  const complete = useCallback(() => {
    if (!context || !port || phase === "completed") return;
    port.postMessage(envelope("state.put", { state: { furthest_page: furthestChapter.current, completed: true } }, context.correlation_id));
    emit(completedStatement(context, () => crypto.randomUUID()));
    port.postMessage(envelope("experience.complete", {}, context.correlation_id));
    setPhase("completed");
  }, [context, port, phase, emit]);

  const goTo = useCallback((next: number) => {
    if (!book) return;
    const clamped = Math.max(0, Math.min(next, book.chapters.length - 1));
    setChapterIndex(clamped);
    setContentsOpen(false);
    if (!context) return;
    if (clamped > furthestChapter.current) {
      for (const quartile of quartilesCrossed(furthestChapter.current, clamped, book.chapters.length)) {
        emit(progressStatement(context, () => crypto.randomUUID(), quartile));
      }
      furthestChapter.current = clamped;
      port?.postMessage(envelope("state.put", { state: { furthest_page: clamped, completed: false } }, context.correlation_id));
    }
  }, [book, context, port, emit]);

  // Same rule as document-player: reaching the last spine item completes the attempt, checked on
  // display rather than only from goTo so a one-page book completes too.
  useEffect(() => {
    if (!book || phase !== "reading") return;
    if (chapterIndex === book.chapters.length - 1) complete();
  }, [book, phase, chapterIndex, complete]);

  // In-book links: an internal one moves the reader to that spine item (and fragment); an external
  // one was already reduced to text by renderChapter and goes nowhere.
  const onPaneClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    if (anchor.hasAttribute("data-epub-external")) { event.preventDefault(); return; }
    const target = anchor.getAttribute("data-epub-chapter");
    const fragment = anchor.getAttribute("data-epub-fragment");
    if (target === null) { if (!fragment) event.preventDefault(); return; }
    event.preventDefault();
    const index = Number(target);
    if (index !== chapterIndex) goTo(index);
    if (fragment) requestAnimationFrame(() => readingPane.current?.querySelector(`#${CSS.escape(fragment)}`)?.scrollIntoView());
  }, [chapterIndex, goTo]);

  const palette = paletteFor(content?.launch_context?.theme);
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const readerCss = useMemo(() => readerStylesheet(palette), [palette]);
  useEffect(() => { document.body.style.background = palette.page; document.body.style.margin = "0"; }, [palette]);

  const chapter = book?.chapters[chapterIndex];
  const total = book?.chapters.length ?? 0;

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.h1}>{content?.title ?? book?.title ?? "Ebook"}</h1>
          <p style={styles.byline}>
            {content?.author ?? book?.creator ?? ""}
            {content?.description && <span style={styles.lede}> · {content.description}</span>}
          </p>
        </div>
        {book && (
          <div style={styles.toolbar}>
            <button type="button" style={styles.secondary} aria-expanded={contentsOpen} onClick={() => setContentsOpen((open) => !open)}>
              Contents
            </button>
            <span style={styles.stepLabel} aria-live="polite">Page {chapterIndex + 1} of {total}</span>
            <button type="button" style={styles.secondary} disabled={chapterIndex === 0} onClick={() => goTo(chapterIndex - 1)}>Previous</button>
            <button type="button" style={styles.button} disabled={chapterIndex === total - 1} onClick={() => goTo(chapterIndex + 1)}>Next</button>
          </div>
        )}
      </header>

      {phase === "waiting" && (
        <p style={styles.notice} role="status">
          Waiting for activity context from the Player Shell… This book must run inside an embedded LORB launch.
        </p>
      )}
      {phase === "loading" && <p style={styles.notice} role="status">Opening the book…</p>}

      {book && contentsOpen && (
        <nav style={styles.contents} aria-label="Table of contents">
          <ol style={styles.contentsList}>
            {(book.toc.length > 0 ? book.toc : book.chapters.map((c, i) => ({ label: c.title, href: c.href, chapterIndex: i }))).map((entry, position) => (
              <li key={`${entry.href}-${position}`}>
                <button
                  type="button"
                  style={entry.chapterIndex === chapterIndex ? styles.contentsCurrent : styles.contentsEntry}
                  disabled={entry.chapterIndex === undefined}
                  aria-current={entry.chapterIndex === chapterIndex ? "page" : undefined}
                  onClick={() => entry.chapterIndex !== undefined && goTo(entry.chapterIndex)}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}

      {book && rendered && chapter && (
        <section style={styles.card} aria-label={chapter.title}>
          <style>{readerCss}{rendered.css}</style>
          {/* The chapter is the book's own XHTML, reduced to its body and stripped of every element
              that could run or fetch (see epub.ts) — the reader is what executes here, never the book. */}
          <div ref={readingPane} className="epub-body" style={styles.pane} onClick={onPaneClick} dangerouslySetInnerHTML={{ __html: rendered.html }} />
          <div style={styles.actions}>
            <button type="button" style={styles.secondary} disabled={chapterIndex === 0} onClick={() => goTo(chapterIndex - 1)}>Previous</button>
            <button type="button" style={styles.button} disabled={chapterIndex === total - 1} onClick={() => goTo(chapterIndex + 1)}>Next</button>
          </div>
        </section>
      )}

      {phase === "completed" && (
        <p style={styles.notice}>{emitted.length} xAPI statements were emitted for this attempt.</p>
      )}

      {phase === "error" && <p role="alert" style={styles.error}>{message}</p>}
    </main>
  );
}

/** The reader's own typography for a book's pages, plus visual treatment for the EDUPUB
 * `epub:type` vocabulary a book may carry: learning objectives and outcomes, keywords, practice
 * activities, assessments with questions and revealable answers, sidebars. Applied before the book's
 * stylesheet, so a book that styles these itself wins. */
function readerStylesheet(p: Palette): string {
  const s = SCOPE;
  return `
${s}{font:17px/1.65 Georgia,"Times New Roman",serif;color:${p.ink};overflow-wrap:break-word}
${s} h1,${s} h2,${s} h3{font-family:system-ui,sans-serif;line-height:1.25;color:${p.ink}}
${s} h1{font-size:1.6em;margin:0 0 .4em}
${s} h2{font-size:1.2em;margin:1.4em 0 .5em}
${s} p{margin:0 0 .9em}
${s} img,${s} svg{max-width:100%;height:auto}
${s} figure{margin:1.25em 0}
${s} figcaption{font-family:system-ui,sans-serif;font-size:.85em;color:${p.muted}}
${s} table{border-collapse:collapse;width:100%;font-family:system-ui,sans-serif;font-size:.92em}
${s} th,${s} td{border:1px solid ${p.border};padding:.45em .6em;text-align:left;vertical-align:top;overflow-wrap:normal}
${s} caption{font-weight:600;text-align:left;margin-bottom:.4em}
${s} a{color:${p.accent}}
${s} a[data-epub-external]{color:${p.muted};text-decoration:underline dotted;cursor:help}
${s} [epub\\:type~="learning-objectives"],${s} [epub\\:type~="learning-outcomes"]{background:${p.soft};border-left:4px solid ${p.accent};border-radius:.4em;padding:.8em 1em;margin:1em 0;font-family:system-ui,sans-serif;font-size:.95em}
${s} [epub\\:type~="learning-objectives"] h2,${s} [epub\\:type~="learning-outcomes"] h2{margin:0 0 .4em;font-size:.8em;letter-spacing:.06em;text-transform:uppercase;color:${p.muted}}
${s} [epub\\:type~="learning-objectives"] ol,${s} [epub\\:type~="learning-outcomes"] ul{margin:0;padding-left:1.4em}
${s} dfn[epub\\:type~="keyword"]{font-style:normal;font-weight:700;color:${p.accent}}
${s} [epub\\:type~="sidebar"],${s} [epub\\:type~="note"]{border:1px solid ${p.border};border-radius:.5em;padding:.8em 1em;margin:1em 0;background:${p.card}}
${s} [epub\\:type~="sidebar"] h2,${s} [epub\\:type~="practice"] h2{margin-top:0}
${s} [epub\\:type~="practice"]{border:1px dashed ${p.accent};border-radius:.5em;padding:.8em 1em;margin:1.25em 0}
${s} [epub\\:type~="question"]{margin-bottom:1em}
${s} [epub\\:type~="answer"]{background:${p.soft};border-radius:.4em;padding:.5em .8em;margin:.4em 0 0}
${s} [epub\\:type~="answer"] summary{cursor:pointer;font-family:system-ui,sans-serif;font-weight:600;color:${p.accent}}
${s} [epub\\:type~="answer"] p{margin:.5em 0 0}
`;
}

function buildStyles(palette: Palette): Record<string, React.CSSProperties> {
  return {
    main: { maxWidth: 820, margin: "0 auto", padding: "1.25rem", font: "16px/1.5 system-ui,sans-serif", color: palette.ink },
    header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" },
    h1: { fontSize: "1.15rem", margin: "0 0 .2rem" },
    byline: { color: palette.muted, fontSize: ".9rem", margin: 0 },
    lede: { color: palette.muted },
    toolbar: { display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap" },
    notice: { color: palette.muted, fontSize: ".9rem" },
    contents: { border: `1px solid ${palette.border}`, borderRadius: ".75rem", padding: ".75rem 1rem", background: palette.card, marginBottom: "1rem" },
    contentsList: { margin: 0, padding: 0, listStyle: "none" },
    contentsEntry: { background: "none", border: 0, padding: ".25rem 0", font: "inherit", color: palette.accent, cursor: "pointer", textAlign: "left" },
    contentsCurrent: { background: "none", border: 0, padding: ".25rem 0", font: "inherit", fontWeight: 700, color: palette.ink, textAlign: "left" },
    card: { border: `1px solid ${palette.border}`, borderRadius: ".75rem", padding: "1.5rem clamp(1rem, 4vw, 2.5rem)", background: palette.card },
    pane: { minHeight: "12rem" },
    stepLabel: { fontSize: ".8rem", fontWeight: 600, color: palette.muted, textTransform: "uppercase", letterSpacing: ".04em", padding: "0 .25rem" },
    actions: { display: "flex", gap: ".75rem", marginTop: "1.5rem", justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" },
    button: { padding: ".6rem 1.1rem", borderRadius: ".5rem", border: 0, background: palette.accent, color: palette.accentInk, font: "inherit", fontWeight: 600, cursor: "pointer" },
    secondary: { padding: ".6rem 1.1rem", borderRadius: ".5rem", border: `1px solid ${palette.border}`, background: palette.card, color: palette.ink, font: "inherit", cursor: "pointer" },
    error: { color: palette.error },
  };
}
