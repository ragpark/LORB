import { useCallback, useEffect, useMemo, useState } from "react";
import type { LaunchContext, QuizContent } from "../../contracts/src/index.js";
import { markQuiz, quizStatementChain, type ShellContext, type XapiStatement } from "./statements.js";

/**
 * Handshake with the Player Shell.
 *
 * The module opens a MessageChannel, keeps one port, and hands the other to the shell inside a
 * `module.hello` message. Everything after that — `shell.context` inbound, evidence and completion
 * outbound — travels down that private port.
 *
 * This exists because the shell cannot postMessage *into* a correctly sandboxed module: without
 * `allow-same-origin` the module's origin is opaque, so a message targeted at the package origin is
 * dropped by the browser and only "*" would arrive. The port sidesteps that: it carries no target
 * origin because it is reachable only by its two endpoints.
 *
 */
/**
 * The target origin for the outbound handshake.
 *
 * `document.referrer` names the shell when the shell has an origin to name. It does not when the
 * shell is itself sandboxed without `allow-same-origin` — the Learner Portal embeds it exactly that
 * way — because a document with an opaque origin sends no referrer. An opaque origin also cannot be
 * addressed by any concrete target origin, so in that case "*" is not a shortcut, it is the only
 * value that reaches the shell at all.
 *
 * This does not move the shell's trust decision. `handshakeAllowed` accepts a hello only from the
 * window it put in its own iframe, carrying the per-launch nonce it placed in that document's URL,
 * and the target origin a sender chose is not part of that test. What "*" widens is who could
 * observe the hello, and the only window that can is `parent` — which, if it is not the shell, is a
 * page that already embedded this module and wrote its fragment.
 *
 * Approved as option A on #59 and flagged for LORB-001 re-review: it changes the postMessage
 * posture, even though it leaves every enforced control intact.
 */
function shellTarget(): string {
  return document.referrer ? new URL(document.referrer).origin : "*";
}

/** The shell places a per-launch nonce in this document's URL fragment; only the document it
 * navigated to receives it. Presenting it proves we are that document and not a later one that
 * replaced it in the same browsing context. */
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

/** Opens the channel and resolves with the port once the shell answers with `shell.context`. */
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

type Phase = "waiting" | "loading" | "answering" | "review" | "submitted" | "error";

/** The content payload as the runtime delivers it: the quiz, plus any publisher-authored launch context. */
type DeliveredContent = QuizContent & { launch_context?: LaunchContext };

/**
 * The themes this package ships. A launch context names one by token — never by URL, because this
 * document runs sandboxed under a CSP that an external stylesheet would either violate or widen —
 * and a token this package does not recognise falls back to the default look rather than failing
 * the launch: presentation is not worth refusing a learner their questions over.
 */
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
  const [answers, setAnswers] = useState<Array<string | undefined>>([]);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [message, setMessage] = useState("");
  const [emitted, setEmitted] = useState<XapiStatement[]>([]);

  useEffect(() => connectToShell((received, openPort) => {
    setContext(received);
    setPort(openPort);
  }), []);

  // The quiz is data, not code: the player fetches the structured content payload the learning
  // object points at and renders it. One reviewed player package serves every quiz.
  useEffect(() => {
    if (!context?.content_url || !port) return;
    let cancelled = false;
    setPhase("loading");
    void fetch(context.content_url, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`Content request failed (${response.status})`))))
      .then((body: DeliveredContent) => {
        if (cancelled) return;
        setContent(body);
        setAnswers(new Array(body.questions.length).fill(undefined));
        setPhase("answering");
        // `launched` opens the verb chain as soon as the learner actually has the activity in front
        // of them, not merely when the descriptor was minted.
        const chain = [quizStatementChain(context, () => crypto.randomUUID(), body, [])[0]!];
        port.postMessage(envelope("evidence.emit", { statement: chain[0] }, context.correlation_id));
        setEmitted(chain);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setPhase("error");
        setMessage(error.message);
        port.postMessage(envelope("experience.error", { code: "QUIZ_CONTENT_UNAVAILABLE", recoverable: false, detail: error.message }, context.correlation_id));
      });
    return () => { cancelled = true; };
  }, [context, port]);

  const mark = useMemo(() => (content ? markQuiz(content, answers) : undefined), [content, answers]);

  const submit = useCallback(() => {
    if (!context || !content || !port) return;
    // Marking, scoring, and the answer key all stay inside this package.
    const chain = quizStatementChain(context, () => crypto.randomUUID(), content, answers);
    // The `launched` statement was already emitted when the content loaded.
    // Persist the attempt state before completing. Besides being the honest thing for a resumable
    // activity to do, this is what moves the attempt CREATED -> STARTED; the Runtime only accepts a
    // completion from STARTED, so a module that never saves state can never legally complete.
    port.postMessage(envelope("state.put", { state: { answers, submitted: true } }, context.correlation_id));
    const remaining = chain.slice(1);
    for (const statement of remaining) port.postMessage(envelope("evidence.emit", { statement }, context.correlation_id));
    setEmitted((previous) => [...previous, ...remaining]);
    port.postMessage(envelope("experience.complete", {}, context.correlation_id));
    setPhase("submitted");
  }, [context, content, answers, port]);

  const question = content?.questions[index];
  const styles = useMemo(() => buildStyles(paletteFor(content?.launch_context?.theme)), [content?.launch_context?.theme]);
  useEffect(() => { document.body.style.background = paletteFor(content?.launch_context?.theme).page; }, [content?.launch_context?.theme]);

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>{content?.title ?? "Quiz"}</h1>
      <p style={styles.lede}>
        A generic quiz player. The questions come from a structured content payload attached to this
        learning object; this package contains no quiz content of its own.
      </p>

      {phase === "waiting" && (
        <p style={styles.notice} role="status">
          Waiting for activity context from the Player Shell… This quiz must run inside an embedded LORB launch.
        </p>
      )}
      {phase === "loading" && <p style={styles.notice} role="status">Loading questions…</p>}

      {phase === "answering" && question && content && (
        <section style={styles.card} aria-live="polite">
          <p style={styles.stepLabel}>Question {index + 1} of {content.questions.length}</p>
          <fieldset style={styles.fieldset}>
            <legend style={styles.legend}>{question.stem}</legend>
            {question.options.map((option) => (
              <label key={option.id} style={styles.option}>
                <input
                  type="radio"
                  name={`question-${index}`}
                  value={option.id}
                  checked={answers[index] === option.id}
                  onChange={() => setAnswers((previous) => previous.map((value, position) => (position === index ? option.id : value)))}
                />
                <span>{option.text}</span>
              </label>
            ))}
          </fieldset>
          <div style={styles.actions}>
            <button type="button" style={styles.secondary} disabled={index === 0} onClick={() => setIndex((current) => current - 1)}>
              Back
            </button>
            <button
              type="button"
              style={styles.button}
              disabled={answers[index] === undefined}
              onClick={() => (index + 1 < content.questions.length ? setIndex((current) => current + 1) : setPhase("review"))}
            >
              {index + 1 < content.questions.length ? "Next" : "Review"}
            </button>
          </div>
        </section>
      )}

      {phase === "review" && content && (
        <section style={styles.card}>
          <p style={styles.stepLabel}>Review</p>
          <ul style={styles.reviewList}>
            {content.questions.map((entry, position) => (
              <li key={entry.stem}>
                <strong>{entry.stem}</strong>
                <p>{entry.options.find((option) => option.id === answers[position])?.text ?? "(no answer given)"}</p>
              </li>
            ))}
          </ul>
          <div style={styles.actions}>
            <button type="button" style={styles.secondary} onClick={() => { setPhase("answering"); setIndex(0); }}>Change answers</button>
            <button type="button" style={styles.button} onClick={submit}>Submit quiz</button>
          </div>
        </section>
      )}

      {phase === "submitted" && content && mark && (
        <section style={styles.card}>
          <p style={styles.stepLabel}>Quiz submitted</p>
          <p style={styles.score}>You scored {mark.correct} out of {mark.total}.</p>
          <ul style={styles.reviewList}>
            {content.questions.map((entry, position) => (
              <li key={entry.stem}>
                <strong>{entry.stem}</strong>
                <p>{answers[position] === entry.correct_option_id ? "Correct" : "Not correct"}{entry.explanation ? ` — ${entry.explanation}` : ""}</p>
              </li>
            ))}
          </ul>
          <p style={styles.notice}>
            {emitted.length} xAPI statements were emitted for this attempt (launched, answered, completed).
          </p>
        </section>
      )}

      {phase === "error" && <p role="alert" style={styles.error}>{message}</p>}
    </main>
  );
}

function buildStyles(palette: Palette): Record<string, React.CSSProperties> {
  return {
    main: { maxWidth: 640, margin: "0 auto", padding: "1.5rem", font: "16px/1.5 system-ui,sans-serif", color: palette.ink },
    h1: { fontSize: "1.15rem", margin: "0 0 .25rem" },
    lede: { color: palette.muted, fontSize: ".9rem", margin: "0 0 1.25rem" },
    notice: { color: palette.muted, fontSize: ".9rem" },
    card: { border: `1px solid ${palette.border}`, borderRadius: ".75rem", padding: "1.25rem", background: palette.card },
    stepLabel: { margin: "0 0 .5rem", fontSize: ".8rem", fontWeight: 600, color: palette.muted, textTransform: "uppercase", letterSpacing: ".04em" },
    fieldset: { border: 0, margin: 0, padding: 0 },
    legend: { fontWeight: 600, marginBottom: ".75rem", padding: 0 },
    option: { display: "flex", gap: ".6rem", alignItems: "flex-start", padding: ".45rem 0" },
    actions: { display: "flex", gap: ".75rem", marginTop: "1rem" },
    button: { padding: ".6rem 1.1rem", borderRadius: ".5rem", border: 0, background: palette.accent, color: palette.accentInk, font: "inherit", fontWeight: 600, cursor: "pointer" },
    secondary: { padding: ".6rem 1.1rem", borderRadius: ".5rem", border: `1px solid ${palette.border}`, background: palette.card, color: palette.ink, font: "inherit", cursor: "pointer" },
    reviewList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: ".75rem" },
    score: { fontWeight: 600 },
    error: { color: palette.error },
  };
}
