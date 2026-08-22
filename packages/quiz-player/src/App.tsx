import { useCallback, useEffect, useMemo, useState } from "react";
import type { QuizContent } from "../../contracts/src/index.js";
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
 * The outbound `module.hello` still targets the shell's exact origin — the shell is same-origin with
 * the package here, so `document.referrer` gives it, and a wildcard is never used in either direction.
 */
function shellOrigin(): string | null {
  return document.referrer ? new URL(document.referrer).origin : null;
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
  const origin = shellOrigin();
  if (!origin) return () => undefined;
  const channel = new MessageChannel();
  const port = channel.port1;
  port.onmessage = (event: MessageEvent) => {
    const data = event.data as { protocol?: string; type?: string; payload?: ShellContext } | null;
    if (!data || data.protocol !== "lorb-player" || data.type !== "shell.context" || !data.payload) return;
    onContext(data.payload, port);
  };
  port.start();
  parent.postMessage(envelope("module.hello", {}), origin, [channel.port2]);
  return () => port.close();
}

type Phase = "waiting" | "loading" | "answering" | "review" | "submitted" | "error";

export function App() {
  const [context, setContext] = useState<ShellContext>();
  const [port, setPort] = useState<MessagePort>();
  const [content, setContent] = useState<QuizContent>();
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
      .then((body: QuizContent) => {
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

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 640, margin: "0 auto", padding: "1.5rem", font: "16px/1.5 system-ui,sans-serif", color: "#1f2933" },
  h1: { fontSize: "1.15rem", margin: "0 0 .25rem" },
  lede: { color: "#52606d", fontSize: ".9rem", margin: "0 0 1.25rem" },
  notice: { color: "#52606d", fontSize: ".9rem" },
  card: { border: "1px solid #d9dee3", borderRadius: ".75rem", padding: "1.25rem", background: "#fff" },
  stepLabel: { margin: "0 0 .5rem", fontSize: ".8rem", fontWeight: 600, color: "#7b8794", textTransform: "uppercase", letterSpacing: ".04em" },
  fieldset: { border: 0, margin: 0, padding: 0 },
  legend: { fontWeight: 600, marginBottom: ".75rem", padding: 0 },
  option: { display: "flex", gap: ".6rem", alignItems: "flex-start", padding: ".45rem 0" },
  actions: { display: "flex", gap: ".75rem", marginTop: "1rem" },
  button: { padding: ".6rem 1.1rem", borderRadius: ".5rem", border: 0, background: "#3b5b92", color: "#fff", font: "inherit", fontWeight: 600, cursor: "pointer" },
  secondary: { padding: ".6rem 1.1rem", borderRadius: ".5rem", border: "1px solid #cbd2d9", background: "#fff", font: "inherit", cursor: "pointer" },
  reviewList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: ".75rem" },
  score: { fontWeight: 600 },
  error: { color: "#b91c1c" },
};
