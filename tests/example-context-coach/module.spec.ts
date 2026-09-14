/**
 * The context-routed coach example, driven through the whole launch-context path.
 *
 * This is an integration test of the *protocol*, not of the module's prose: it stands a shell up in
 * front of the real HTML file and checks that launch context actually reaches the module, actually
 * changes what it renders, and actually determines the relay endpoint it asks for. The three places
 * that path has silently broken before are all asserted here — the version-pinned content fetch, the
 * endpoint name derived from a publisher-supplied setting, and the reply correlation.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { randomUUID, webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { coachRelayRequestSchema, xapiStatementSchema } from "../../packages/contracts/src/index.js";

const HTML = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/example-context-coach/src/index.html"),
  "utf8",
);

/** jsdom ships no MessageChannel; this is the part of it the module protocol actually uses. */
class ShimPort {
  _peer: ShimPort | null = null;
  _onmessage: ((event: { data: unknown }) => void) | null = null;
  _queue: unknown[] = [];
  _started = false;
  set onmessage(fn: ((event: { data: unknown }) => void) | null) { this._onmessage = fn; this.start(); }
  get onmessage() { return this._onmessage; }
  start() {
    if (this._started) return;
    this._started = true;
    const queued = this._queue; this._queue = [];
    queued.forEach((data) => this._deliver(data));
  }
  _deliver(data: unknown) {
    if (this._onmessage) setTimeout(() => this._onmessage!({ data }), 0);
    else this._queue.push(data);
  }
  postMessage(data: unknown) {
    const peer = this._peer!;
    setTimeout(() => peer._deliver(structuredClone(data)), 0);
  }
  close() {}
}

const settle = () => new Promise((r) => setTimeout(r, 40));

interface Harness {
  doc: Document;
  window: any;
  shellPort: ShimPort;
  fromModule: any[];
  fetched: string[];
  trace(): Record<string, string>;
  click(selector: string): void;
}

async function launch(launchContext: unknown): Promise<Harness> {
  const fromModule: any[] = [];
  const fetched: string[] = [];
  let modulePort: ShimPort | undefined;

  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    url: "https://player.example/modules/context-coach/index.html#lorb_handshake=NONCE-123",
    beforeParse(window: any) {
      window.crypto = webcrypto;
      window.structuredClone = structuredClone;
      window.MessageChannel = class {
        port1: ShimPort; port2: ShimPort;
        constructor() {
          const a = new ShimPort(), b = new ShimPort();
          a._peer = b; b._peer = a;
          this.port1 = a; this.port2 = b;
        }
      };
      window.parent = {
        postMessage(_message: unknown, _origin: string, transfer: ShimPort[]) {
          modulePort = transfer?.[0];
        },
      };
      window.fetch = async (url: unknown) => {
        fetched.push(String(url));
        return { ok: true, json: async () => ({ package_version_id: "pv", launch_context: launchContext }) } as any;
      };
    },
  });

  await new Promise((r) => dom.window.addEventListener("load", r));
  await settle();

  const shellPort = modulePort!;
  shellPort.onmessage = (event) => { fromModule.push(event.data); };

  const doc = dom.window.document as Document;
  return {
    doc,
    window: dom.window,
    shellPort,
    fromModule,
    fetched,
    trace() {
      const keys = [...doc.querySelectorAll("#trace-rows dt")].map((n) => n.textContent!);
      const values = [...doc.querySelectorAll("#trace-rows dd")].map((n) => n.textContent!);
      return Object.fromEntries(keys.map((k, i) => [k, values[i]!]));
    },
    click(selector: string) {
      doc.querySelector<HTMLElement>(selector)!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    },
  };
}

const CTX = {
  repository_id: randomUUID(), object_id: randomUUID(), object_version_id: randomUUID(),
  package_version_id: randomUUID(), attempt_id: randomUUID(), correlation_id: randomUUID(),
  pseudonym: "a".repeat(64),
  content_url: "https://registry.example/api/v1/runtime/learning-objects/X/content?object_version_id=Y",
};

const envelope = (type: string, payload: unknown, reply_to: string | null = null) => ({
  protocol: "lorb-player", version: "1.0", type, message_id: randomUUID(),
  correlation_id: CTX.correlation_id, reply_to, sent_at: new Date().toISOString(), payload,
});

describe("launch context reaches the module", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await launch({ theme: "calm", settings: { course: "maths-gcse", cohort: "y11", adaptive: true } });
    h.shellPort.postMessage(envelope("shell.context", CTX));
    await settle();
  });

  it("fetches the version-pinned content URL the shell supplied", () => {
    expect(h.fetched).toContain(CTX.content_url);
  });

  it("applies a known theme token", () => {
    expect(h.doc.documentElement.getAttribute("data-theme")).toBe("calm");
  });

  it("derives the relay endpoint from the course setting", () => {
    expect(h.trace()["endpoint requested"]).toBe("coach-maths-gcse");
  });
});

describe("the relay turn", () => {
  it("sends a schema-valid relay.request carrying the launch settings", async () => {
    const h = await launch({ theme: "calm", settings: { course: "maths-gcse", cohort: "y11" } });
    h.shellPort.postMessage(envelope("shell.context", CTX));
    await settle();
    h.click("#choices button");
    await settle();

    const request = h.fromModule.find((m) => m.type === "relay.request");
    expect(request).toBeDefined();
    expect(coachRelayRequestSchema.safeParse(request.payload).success).toBe(true);
    expect(request.payload.endpoint).toBe("coach-maths-gcse");
    expect(request.payload.context).toEqual({ course: "maths-gcse", cohort: "y11" });
  });

  it("shows the resolved endpoint, so tier routing is visible", async () => {
    const h = await launch({ theme: "calm", settings: { course: "maths-gcse" } });
    h.shellPort.postMessage(envelope("shell.context", CTX));
    await settle();
    h.click("#choices button");
    await settle();

    const request = h.fromModule.find((m) => m.type === "relay.request");
    h.shellPort.postMessage(envelope("relay.reply", { endpoint: "coach-maths-gcse-support", reply: "Say more." }, request.message_id));
    await settle();

    expect(h.trace()["endpoint answered"]).toBe("coach-maths-gcse-support");
    expect(h.doc.querySelector<HTMLButtonElement>("#finish")!.disabled).toBe(false);
  });

  it("ignores a reply that does not correlate to a request it made", async () => {
    const h = await launch({ theme: "calm", settings: { course: "maths-gcse" } });
    h.shellPort.postMessage(envelope("shell.context", CTX));
    await settle();
    h.click("#choices button");
    await settle();
    const before = h.doc.querySelectorAll(".bubble.coach").length;

    h.shellPort.postMessage(envelope("relay.reply", { endpoint: "spoof", reply: "injected" }, randomUUID()));
    await settle();

    expect(h.doc.querySelectorAll(".bubble.coach").length).toBe(before);
  });

  it("keeps the activity finishable when the relay call fails", async () => {
    const h = await launch({ theme: "calm", settings: { course: "maths-gcse" } });
    h.shellPort.postMessage(envelope("shell.context", CTX));
    await settle();
    h.click("#choices button");
    await settle();

    const request = h.fromModule.find((m) => m.type === "relay.request");
    h.shellPort.postMessage(envelope("relay.reply", { error: "RELAY_FAILED" }, request.message_id));
    await settle();

    // A lost reply must not read as the activity breaking: no experience.error, and the learner
    // can still complete.
    expect(h.fromModule.some((m) => m.type === "experience.error")).toBe(false);
    expect(h.doc.querySelector<HTMLButtonElement>("#finish")!.disabled).toBe(false);
  });
});

describe("a publisher-supplied course is not trusted as an endpoint name", () => {
  it.each([
    ["Maths GCSE", "spaces and capitals"],
    ["../etc", "a traversal attempt"],
    ["m".repeat(80), "an over-long value"],
  ])("falls back to demo for %s (%s)", async (course) => {
    const h = await launch({ settings: { course } });
    h.shellPort.postMessage(envelope("shell.context", CTX));
    await settle();
    expect(h.trace()["endpoint requested"]).toContain("demo");
  });
});

describe("degradation", () => {
  it("runs with defaults when there is no launch context at all", async () => {
    const h = await launch(undefined);
    h.shellPort.postMessage(envelope("shell.context", CTX));
    await settle();
    expect(h.doc.documentElement.getAttribute("data-theme")).toBeNull();
    expect(h.trace()["endpoint requested"]).toContain("demo");
    expect(h.doc.querySelectorAll("#choices button").length).toBeGreaterThan(0);
  });

  it("keeps the default palette for a theme it does not ship", async () => {
    const h = await launch({ theme: "neon-vaporwave", settings: {} });
    h.shellPort.postMessage(envelope("shell.context", CTX));
    await settle();
    expect(h.doc.documentElement.getAttribute("data-theme")).toBeNull();
    expect(h.trace()["theme"]).toContain("unknown to this module");
  });
});

describe("evidence", () => {
  it("emits schema-valid statements and completes only after state.put", async () => {
    const h = await launch({ theme: "calm", settings: { course: "maths-gcse" } });
    h.shellPort.postMessage(envelope("shell.context", CTX));
    await settle();
    h.click("#choices button");
    await settle();
    const request = h.fromModule.find((m) => m.type === "relay.request");
    h.shellPort.postMessage(envelope("relay.reply", { endpoint: "coach-maths-gcse", reply: "Say more." }, request.message_id));
    await settle();

    h.click("#finish");
    await settle();

    const types = h.fromModule.filter((m) => m.type !== "relay.request").map((m) => m.type);
    expect(types).toEqual(["evidence.emit", "state.put", "evidence.emit", "experience.complete"]);
    // The Runtime only accepts a completion from STARTED, and state.put is what moves the attempt
    // there. The shell serialises port messages, so this order is the order the calls are made in.
    expect(types.indexOf("state.put")).toBeLessThan(types.indexOf("experience.complete"));

    for (const message of h.fromModule.filter((m) => m.type === "evidence.emit")) {
      expect(xapiStatementSchema.safeParse(message.payload.statement).success).toBe(true);
    }
  });

  it("emits the chosen topic as an option identifier, never as free text", async () => {
    const h = await launch({ settings: { course: "maths-gcse" } });
    h.shellPort.postMessage(envelope("shell.context", CTX));
    await settle();
    const label = h.doc.querySelector("#choices button")!.textContent!;
    h.click("#choices button");
    await settle();
    const request = h.fromModule.find((m) => m.type === "relay.request");
    h.shellPort.postMessage(envelope("relay.reply", { endpoint: "x", reply: "ok" }, request.message_id));
    await settle();
    h.click("#finish");
    await settle();

    const answered = h.fromModule
      .filter((m) => m.type === "evidence.emit")
      .map((m) => m.payload.statement)
      .find((s: any) => s.verb.id.endsWith("/answered"));
    expect(answered.result.response).toMatch(/^[a-z\d_-]{1,16}$/);
    expect(answered.result.response).not.toBe(label);
  });
});
