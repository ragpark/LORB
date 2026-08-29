import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentContent, LaunchContext } from "../../contracts/src/index.js";
import { completedStatement, launchedStatement, progressStatement, quartilesCrossed, type ShellContext, type XapiStatement } from "./statements.js";

/** Handshake with the Player Shell — identical to quiz-player/src/App.tsx; see that file for the
 * full rationale. Duplicated per-package by existing repo convention (coach-player does too). */
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
type DeliveredContent = DocumentContent & { launch_context?: LaunchContext };

interface Palette { page: string; ink: string; muted: string; card: string; border: string; accent: string; accentInk: string; error: string }
const PALETTES: Record<string, Palette> = {
  "default": { page: "#ffffff", ink: "#1f2933", muted: "#52606d", card: "#ffffff", border: "#d9dee3", accent: "#3b5b92", accentInk: "#ffffff", error: "#b91c1c" },
  "midnight": { page: "#101725", ink: "#e5eaf1", muted: "#9aa7b8", card: "#1a2333", border: "#2c3a52", accent: "#7aa2e8", accentInk: "#101725", error: "#f2a1a1" },
  "high-contrast": { page: "#ffffff", ink: "#000000", muted: "#1a1a1a", card: "#ffffff", border: "#000000", accent: "#000000", accentInk: "#ffffff", error: "#a00000" },
};
const paletteFor = (theme: string | undefined): Palette => PALETTES[theme ?? "default"] ?? PALETTES["default"]!;

export function App() {
  const [context, setContext] = useState<ShellContext>();
  const [port, setPort] = useState<MessagePort>();
  const [content, setContent] = useState<DeliveredContent>();
  const [pageIndex, setPageIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [message, setMessage] = useState("");
  const [emitted, setEmitted] = useState<XapiStatement[]>([]);
  const furthestPage = useRef(0);

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
      .then((body: DeliveredContent) => {
        if (cancelled) return;
        setContent(body);
        setPhase("reading");
        const statement = launchedStatement(context, () => crypto.randomUUID());
        port.postMessage(envelope("evidence.emit", { statement }, context.correlation_id));
        setEmitted([statement]);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setPhase("error");
        setMessage(error.message);
        port.postMessage(envelope("experience.error", { code: "DOCUMENT_CONTENT_UNAVAILABLE", recoverable: false, detail: error.message }, context.correlation_id));
      });
    return () => { cancelled = true; };
  }, [context, port]);

  const emit = useCallback((statement: XapiStatement) => {
    if (!context || !port) return;
    port.postMessage(envelope("evidence.emit", { statement }, context.correlation_id));
    setEmitted((previous) => [...previous, statement]);
  }, [context, port]);

  const complete = useCallback(() => {
    if (!context || !port || phase === "completed") return;
    port.postMessage(envelope("state.put", { state: { furthest_page: furthestPage.current, completed: true } }, context.correlation_id));
    emit(completedStatement(context, () => crypto.randomUUID()));
    port.postMessage(envelope("experience.complete", {}, context.correlation_id));
    setPhase("completed");
  }, [context, port, phase, emit]);

  const goTo = useCallback((next: number) => {
    if (!content) return;
    const clamped = Math.max(0, Math.min(next, content.pages.length - 1));
    setPageIndex(clamped);
    if (!context) return;
    if (clamped > furthestPage.current) {
      for (const quartile of quartilesCrossed(furthestPage.current, clamped, content.pages.length)) {
        emit(progressStatement(context, () => crypto.randomUUID(), quartile));
      }
      furthestPage.current = clamped;
      port?.postMessage(envelope("state.put", { state: { furthest_page: clamped, completed: false } }, context.correlation_id));
    }
    if (clamped === content.pages.length - 1) complete();
  }, [content, context, port, emit, complete]);

  const styles = useMemo(() => buildStyles(paletteFor(content?.launch_context?.theme)), [content?.launch_context?.theme]);
  useEffect(() => { document.body.style.background = paletteFor(content?.launch_context?.theme).page; }, [content?.launch_context?.theme]);

  const page = content?.pages[pageIndex];

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>{content?.title ?? "Document"}</h1>
      {content?.description && <p style={styles.lede}>{content.description}</p>}

      {phase === "waiting" && (
        <p style={styles.notice} role="status">
          Waiting for activity context from the Player Shell… This document must run inside an embedded LORB launch.
        </p>
      )}
      {phase === "loading" && <p style={styles.notice} role="status">Loading document…</p>}

      {content && page && (
        <section style={styles.card}>
          <p style={styles.stepLabel}>Page {pageIndex + 1} of {content.pages.length}</p>
          {/* Pages are pre-rasterised images, never a native Office/PDF viewer plugin: this document
              runs inside a strictly sandboxed iframe (see quiz-player/src/App.tsx for why), and a
              plugin-hosted viewer either can't run there or would need permissions this player
              deliberately doesn't request. */}
          <img style={styles.page} src={page.image_url} alt={`${content.title}, page ${pageIndex + 1}`} />
          <div style={styles.actions}>
            <button type="button" style={styles.secondary} disabled={pageIndex === 0} onClick={() => goTo(pageIndex - 1)}>
              Previous
            </button>
            <button
              type="button"
              style={styles.button}
              disabled={pageIndex === content.pages.length - 1}
              onClick={() => goTo(pageIndex + 1)}
            >
              Next
            </button>
            {content.pdf_url && (
              <a style={styles.link} href={content.pdf_url} target="_blank" rel="noreferrer noopener">
                Download original
              </a>
            )}
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

function buildStyles(palette: Palette): Record<string, React.CSSProperties> {
  return {
    main: { maxWidth: 760, margin: "0 auto", padding: "1.5rem", font: "16px/1.5 system-ui,sans-serif", color: palette.ink },
    h1: { fontSize: "1.15rem", margin: "0 0 .25rem" },
    lede: { color: palette.muted, fontSize: ".9rem", margin: "0 0 1.25rem" },
    notice: { color: palette.muted, fontSize: ".9rem" },
    card: { border: `1px solid ${palette.border}`, borderRadius: ".75rem", padding: "1.25rem", background: palette.card },
    stepLabel: { margin: "0 0 .75rem", fontSize: ".8rem", fontWeight: 600, color: palette.muted, textTransform: "uppercase", letterSpacing: ".04em" },
    page: { width: "100%", borderRadius: ".5rem", border: `1px solid ${palette.border}`, display: "block" },
    actions: { display: "flex", gap: ".75rem", marginTop: "1rem", alignItems: "center", flexWrap: "wrap" },
    button: { padding: ".6rem 1.1rem", borderRadius: ".5rem", border: 0, background: palette.accent, color: palette.accentInk, font: "inherit", fontWeight: 600, cursor: "pointer" },
    secondary: { padding: ".6rem 1.1rem", borderRadius: ".5rem", border: `1px solid ${palette.border}`, background: palette.card, color: palette.ink, font: "inherit", cursor: "pointer" },
    link: { fontSize: ".9rem", color: palette.accent },
    error: { color: palette.error },
  };
}
