import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LaunchContext, VideoContent } from "../../contracts/src/index.js";
import { completedStatement, launchedStatement, progressStatement, quartilesCrossed, type ShellContext, type XapiStatement } from "./statements.js";

/**
 * Handshake with the Player Shell. Identical to quiz-player/src/App.tsx — see that file for the full
 * rationale on the MessageChannel handshake and the "*" target-origin fallback. Duplicated here
 * rather than shared because no cross-player SDK package exists yet in this repo (coach-player
 * duplicates it too); factoring it out is a good follow-up, not a blocker for this player.
 */
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

type Phase = "waiting" | "loading" | "ready" | "completed" | "error";

type DeliveredContent = VideoContent & { launch_context?: LaunchContext };

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
  const [phase, setPhase] = useState<Phase>("waiting");
  const [message, setMessage] = useState("");
  const [emitted, setEmitted] = useState<XapiStatement[]>([]);
  const watchedFraction = useRef(0);

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
        setPhase("ready");
        const statement = launchedStatement(context, () => crypto.randomUUID());
        port.postMessage(envelope("evidence.emit", { statement }, context.correlation_id));
        setEmitted([statement]);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setPhase("error");
        setMessage(error.message);
        port.postMessage(envelope("experience.error", { code: "VIDEO_CONTENT_UNAVAILABLE", recoverable: false, detail: error.message }, context.correlation_id));
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
    port.postMessage(envelope("state.put", { state: { completed: true } }, context.correlation_id));
    emit(completedStatement(context, () => crypto.randomUUID()));
    port.postMessage(envelope("experience.complete", {}, context.correlation_id));
    setPhase("completed");
  }, [context, port, phase, emit]);

  // File-source progress: native <video> gives real currentTime/duration, so quartile checkpoints
  // and end-of-video completion are both automatic.
  const onTimeUpdate = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!context) return;
    const video = event.currentTarget;
    if (!video.duration || Number.isNaN(video.duration)) return;
    const fraction = video.currentTime / video.duration;
    for (const quartile of quartilesCrossed(watchedFraction.current, fraction)) emit(progressStatement(context, () => crypto.randomUUID(), quartile));
    watchedFraction.current = fraction;
  }, [context, emit]);

  const styles = useMemo(() => buildStyles(paletteFor(content?.launch_context?.theme)), [content?.launch_context?.theme]);
  useEffect(() => { document.body.style.background = paletteFor(content?.launch_context?.theme).page; }, [content?.launch_context?.theme]);

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>{content?.title ?? "Video"}</h1>
      {content?.description && <p style={styles.lede}>{content.description}</p>}

      {phase === "waiting" && (
        <p style={styles.notice} role="status">
          Waiting for activity context from the Player Shell… This video must run inside an embedded LORB launch.
        </p>
      )}
      {phase === "loading" && <p style={styles.notice} role="status">Loading video…</p>}

      {content && content.source.kind === "file" && (
        <section style={styles.card}>
          {/* crossOrigin+captions-friendly: file sources are served from a runtime-controlled origin,
              never an arbitrary third-party URL, so this cannot become a way to embed foreign media. */}
          <video
            style={styles.video}
            controls
            poster={content.poster_url}
            onTimeUpdate={onTimeUpdate}
            onEnded={complete}
          >
            <source src={content.source.url} type={content.source.mime_type} />
            {content.captions_url && <track kind="captions" src={content.captions_url} srcLang="en" label="English" default />}
            Your browser does not support embedded video.
          </video>
          {phase !== "completed" && (
            <div style={styles.actions}>
              <button type="button" style={styles.secondary} onClick={complete}>Mark as watched</button>
            </div>
          )}
        </section>
      )}

      {content && content.source.kind === "youtube" && (
        <section style={styles.card}>
          <div style={styles.youtubeWrap}>
            <iframe
              style={styles.youtubeFrame}
              src={`https://www.youtube-nocookie.com/embed/${content.source.video_id}`}
              title={content.title}
              allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
          <p style={styles.notice}>
            YouTube playback progress is not visible to this sandboxed player, so watch-quartile
            checkpoints aren't available for this source — mark the video watched once you're done.
          </p>
          {phase !== "completed" && (
            <div style={styles.actions}>
              <button type="button" style={styles.button} onClick={complete}>Mark as watched</button>
            </div>
          )}
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
    main: { maxWidth: 720, margin: "0 auto", padding: "1.5rem", font: "16px/1.5 system-ui,sans-serif", color: palette.ink },
    h1: { fontSize: "1.15rem", margin: "0 0 .25rem" },
    lede: { color: palette.muted, fontSize: ".9rem", margin: "0 0 1.25rem" },
    notice: { color: palette.muted, fontSize: ".9rem" },
    card: { border: `1px solid ${palette.border}`, borderRadius: ".75rem", padding: "1.25rem", background: palette.card },
    video: { width: "100%", borderRadius: ".5rem", background: "#000" },
    youtubeWrap: { position: "relative", width: "100%", paddingTop: "56.25%", borderRadius: ".5rem", overflow: "hidden", background: "#000" },
    youtubeFrame: { position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 },
    actions: { display: "flex", gap: ".75rem", marginTop: "1rem" },
    button: { padding: ".6rem 1.1rem", borderRadius: ".5rem", border: 0, background: palette.accent, color: palette.accentInk, font: "inherit", fontWeight: 600, cursor: "pointer" },
    secondary: { padding: ".6rem 1.1rem", borderRadius: ".5rem", border: `1px solid ${palette.border}`, background: palette.card, color: palette.ink, font: "inherit", cursor: "pointer" },
    error: { color: palette.error },
  };
}
