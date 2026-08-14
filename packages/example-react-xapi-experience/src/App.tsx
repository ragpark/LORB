import { useEffect, useState } from "react";

interface ShellContext {
  repository_id: string;
  object_id: string;
  object_version_id: string;
  package_version_id: string;
  attempt_id: string;
  correlation_id: string;
  pseudonym: string;
}

interface XapiStatement {
  id: string;
  actor: { objectType: "Agent"; account: { homePage: string; name: string } };
  verb: { id: string; display: { "en-GB": string } };
  object: { id: string; objectType: "Activity" };
  context: { extensions: Record<string, string> };
  timestamp: string;
}

const PROMPTS = [
  "How confident do you feel applying this skill on the job?",
  "What is one thing that went well while you practised it here?",
  "What is one thing you would like more support with?",
];

/** The Player Shell embeds this module in a sandboxed iframe without allow-same-origin, so the
 * shell itself reports as the opaque origin "null". Accept "null" or the referrer's real origin —
 * never a wildcard. */
function shellOrigin(): string | null {
  return document.referrer ? new URL(document.referrer).origin : null;
}

function emitToShell(type: string, payload: Record<string, unknown>, correlationId?: string) {
  const origin = shellOrigin();
  if (!origin) return false;
  parent.postMessage(
    {
      protocol: "lorb-player",
      version: "1.0",
      type,
      message_id: crypto.randomUUID(),
      correlation_id: correlationId ?? crypto.randomUUID(),
      reply_to: null,
      sent_at: new Date().toISOString(),
      payload,
    },
    origin,
  );
  return true;
}

function buildStatement(context: ShellContext): XapiStatement {
  return {
    id: crypto.randomUUID(),
    actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: context.pseudonym } },
    verb: { id: "http://adlnet.gov/expapi/verbs/completed", display: { "en-GB": "completed" } },
    object: { id: `https://lorb.example/objects/${context.object_id}/versions/${context.object_version_id}`, objectType: "Activity" },
    context: {
      extensions: {
        "https://lorb.example/xapi/repository_id": context.repository_id,
        "https://lorb.example/xapi/attempt_id": context.attempt_id,
        "https://lorb.example/xapi/package_version_id": context.package_version_id,
        "https://lorb.example/xapi/correlation_id": context.correlation_id,
        "https://lorb.example/xapi/completion_authority": "PACKAGE",
      },
    },
    timestamp: new Date().toISOString(),
  };
}

export function App() {
  const [context, setContext] = useState<ShellContext>();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [statement, setStatement] = useState<XapiStatement>();
  const [emitFailed, setEmitFailed] = useState(false);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as { protocol?: string; type?: string; payload?: ShellContext } | null;
      if (!data || data.protocol !== "lorb-player" || data.type !== "shell.context" || !data.payload) return;
      const expected = shellOrigin();
      if (event.origin !== "null" && event.origin !== expected) return;
      setContext(data.payload);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const submit = () => {
    if (!context) return;
    const built = buildStatement(context);
    const sent = emitToShell("evidence.emit", { statement: built }, context.correlation_id);
    if (!sent) {
      setEmitFailed(true);
      return;
    }
    setStatement(built);
    emitToShell("experience.complete", {}, context.correlation_id);
  };

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Reflective Practice Studio</h1>
      <p style={styles.lede}>
        A React web experience learning content example. It emits an xAPI statement over the Player Shell's{" "}
        <code>evidence.emit</code> channel, which the Runtime API queues for delivery to the LORB learning record store.
      </p>

      {!context && !statement && (
        <p style={styles.notice} role="status">
          Waiting for activity context from the Player Shell… This experience must run inside an embedded LORB launch.
        </p>
      )}

      {context && !statement && step < PROMPTS.length && (
        <section style={styles.card} aria-live="polite">
          <p style={styles.stepLabel}>
            Step {step + 1} of {PROMPTS.length}
          </p>
          <label style={styles.label} htmlFor="answer">
            {PROMPTS[step]}
          </label>
          <textarea
            id="answer"
            style={styles.textarea}
            rows={3}
            value={answers[step]}
            onChange={(event) => setAnswers((prev) => prev.map((value, index) => (index === step ? event.target.value : value)))}
          />
          <button
            type="button"
            style={styles.button}
            onClick={() => setStep((current) => current + 1)}
          >
            {step + 1 < PROMPTS.length ? "Continue" : "Review"}
          </button>
        </section>
      )}

      {context && !statement && step === PROMPTS.length && (
        <section style={styles.card}>
          <p style={styles.stepLabel}>Review</p>
          <ul style={styles.reviewList}>
            {PROMPTS.map((prompt, index) => (
              <li key={prompt}>
                <strong>{prompt}</strong>
                <p>{answers[index] || "(no answer given)"}</p>
              </li>
            ))}
          </ul>
          <button type="button" style={styles.button} onClick={submit}>
            Submit reflection
          </button>
        </section>
      )}

      {statement && (
        <section style={styles.card}>
          <p style={styles.stepLabel}>Reflection submitted</p>
          <p>An xAPI statement was emitted for this activity. It will appear in the Ops Console evidence outbox before forwarding to the learning record store.</p>
          <pre style={styles.pre}>{JSON.stringify(statement, null, 2)}</pre>
        </section>
      )}

      {emitFailed && (
        <p role="alert" style={styles.error}>
          This experience must be opened inside the LORB Player Shell to submit a reflection.
        </p>
      )}
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
  label: { display: "block", fontWeight: 600, marginBottom: ".5rem" },
  textarea: { width: "100%", padding: ".6rem", borderRadius: ".5rem", border: "1px solid #cbd2d9", font: "inherit", resize: "vertical" },
  button: { marginTop: "1rem", padding: ".6rem 1.1rem", borderRadius: ".5rem", border: 0, background: "#3b5b92", color: "#fff", font: "inherit", fontWeight: 600, cursor: "pointer" },
  reviewList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: ".75rem" },
  pre: { background: "#0f172a", color: "#e2e8f0", padding: "1rem", borderRadius: ".5rem", overflowX: "auto", fontSize: ".75rem" },
  error: { color: "#b91c1c" },
};
