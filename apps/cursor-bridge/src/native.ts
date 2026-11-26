import { localOwnerClose } from "./lifecycle.js";
import { CursorError } from "./cursor.js";
import { CURSOR_KEY_GUIDANCE } from "./credentials.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { RunResult, SDKMessage } from "@cursor/sdk";
import type { CursorAgent, CursorFactory, CursorRun } from "./types.js";

class StreamRun implements CursorRun {
  private messages: SDKMessage[] = [];
  private streamEnded = false;
  private streamError?: Error;
  private wake?: () => void;
  private resolve!: (result: RunResult) => void;
  private reject!: (error: Error) => void;
  private completed = new Promise<RunResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  steer?: (text: string) => Promise<"complete_delivered" | "revert_to_followup">;
  constructor(readonly id: string, private client: Client, supportsSteer: boolean) {
    void this.completed.catch(() => {});
    if (supportsSteer) this.steer = async (text) => await client.call("steer", { runId: id, text }) as "complete_delivered" | "revert_to_followup";
  }
  push(message: SDKMessage): void {
    if (this.streamEnded) return;
    this.messages.push(message);
    this.wake?.();
  }
  finishStream(failed: boolean): void {
    if (this.streamEnded) return;
    this.streamEnded = true;
    if (failed) this.streamError = Error("Cursor SDK stream unavailable");
    this.wake?.();
  }
  finish(result?: RunResult): void {
    if (result) this.resolve(result); else this.reject(Error("SDK run outcome unknown"));
  }
  async *stream(signal?: AbortSignal): AsyncIterable<SDKMessage> {
    const discardOutput = () => {
      this.messages.length = 0;
      this.finishStream(false);
      void this.client.call("discard-output", { runId: this.id }).catch(() => {});
    };
    if (signal?.aborted) discardOutput();
    else signal?.addEventListener("abort", discardOutput, { once: true });
    try {
      while (true) {
        const next = this.messages.shift();
        if (next) { yield next; continue; }
        if (this.streamError) throw this.streamError;
        if (this.streamEnded) break;
        await new Promise<void>((resolve) => { this.wake = resolve; });
        this.wake = undefined;
      }
      await this.completed;
    } finally {
      signal?.removeEventListener("abort", discardOutput);
    }
  }
  wait(): Promise<RunResult> { return this.completed; }
  async cancel(): Promise<void> { await this.client.call("cancel", { runId: this.id }); }
}
declare const CURSOR_WORKER_SHA256: string;
class Client {
  static async create(signal?: AbortSignal): Promise<Client> {
    signal?.throwIfAborted();
    const bytes = await readFile(new URL("./sdk-worker.mjs", import.meta.url));
    if (createHash("sha256").update(bytes).digest("hex") !== CURSOR_WORKER_SHA256) throw Error("Cursor worker digest mismatch");
    signal?.throwIfAborted();
    return new Client();
  }
  private worker = new Worker(new URL("./sdk-worker.mjs", import.meta.url), { stdout: true, stderr: true });
  private serial = 0;
  private dead = false;
  private closing?: Promise<void>;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private run?: StreamRun;
  constructor() {
    this.worker.stdout?.resume(); this.worker.stderr?.resume();
    this.worker.on("message", (m) => {
      if (m.event) {
        const run = this.run;
        if (!run || run.id !== m.runId) return;
        if (m.event === "message") run.push(m.message);
        else if (m.event === "terminal") run.finish(m.result);
        else if (m.event === "stream-end" || m.event === "stream-error") run.finishStream(m.event === "stream-error");
        return;
      }
      const pending = this.pending.get(m.id);
      if (!pending) return;
      this.pending.delete(m.id);
      if (m.error) {
        const kind: "auth" | "quota" | "invalid" | "explicit-reject" | "unknown-outcome" = m.error === "auth" || m.error === "quota" || m.error === "invalid" || m.error === "explicit-reject" ? m.error : "unknown-outcome";
        const messages = { auth: CURSOR_KEY_GUIDANCE, quota: "Cursor usage limit reached. Check the account's quota before trying again.",
          invalid: "Cursor could not create the session. Check the model, workspace and private state directory.",
          "explicit-reject": "Cursor refused this session because it is busy. Check its current session before trying again.",
          "unknown-outcome": "Cursor operation outcome is unknown. Query the existing command; do not resend it." };
        pending.reject(new CursorError(kind, messages[kind])); return;
      }
      if (pending.method === "send") {
        const run = new StreamRun(m.result.id, this, m.result.supportsSteer === true);
        this.run = run;
        pending.resolve(run);
      } else pending.resolve(m.result);
    });
    this.worker.on("error", () => this.lost());
    this.worker.on("exit", () => this.lost());
  }
  private lost(): void {
    this.dead = true;
    for (const p of this.pending.values()) p.reject(Error("Cursor worker lost; outcome unknown"));
    this.pending.clear();
    this.run?.finish();
    this.run?.finishStream(true);
    this.run = undefined;
  }
  call(method: string, params: Record<string, string> = {}): Promise<unknown> {
    if (this.dead) return Promise.reject(Error("Cursor worker unavailable; no replay"));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.worker.postMessage({ id, method, params });
    });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.worker.terminate();
      this.lost();
    })().catch(error => { this.closing = undefined; throw error; });
  }
}

async function withProvisionalClient<T>(signal: AbortSignal | undefined, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await Client.create(signal);
  const onAbort = () => { void client.close().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await work(client);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    await client.close();
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export const cursorFactory: CursorFactory = {
  async hasCredentials(signal) {
    return withProvisionalClient(signal, async client => {
      const available = await client.call("auth") === true;
      await client.close();
      return available;
    });
  },
  async models(signal) {
    return withProvisionalClient(signal, async client => {
      const models = await client.call("models") as { id: string; name: string }[];
      await client.close();
      return models;
    });
  },
  async create(cwd, model, stateDirectory, signal): Promise<CursorAgent> {
    return withProvisionalClient(signal, async client => {
      const result = await client.call("create", { cwd, model, stateDirectory }) as { agentId: string };
      const close = localOwnerClose(() => client.call("close"), () => client.close());
      return { agentId: result.agentId, send: async (text) => await client.call("send", { text }) as CursorRun,
        close };
    });
  },
};
