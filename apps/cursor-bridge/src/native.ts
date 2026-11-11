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
  private terminal = false;
  private wake?: () => void;
  private resolve!: (result: RunResult) => void;
  private reject!: (error: Error) => void;
  private completed = new Promise<RunResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  steer?: (text: string) => Promise<"complete_delivered" | "revert_to_followup">;
  constructor(readonly id: string, private client: Client, supportsSteer: boolean) {
    void this.completed.catch(() => {});
    if (supportsSteer) this.steer = async (text) => await client.call("steer", { runId: id, text }) as "complete_delivered" | "revert_to_followup";
  }
  push(message: SDKMessage): void { this.messages.push(message); this.wake?.(); }
  finish(result?: RunResult): void {
    this.terminal = true;
    if (result) this.resolve(result); else this.reject(Error("SDK run outcome unknown"));
    this.wake?.();
  }
  async *stream(): AsyncIterable<SDKMessage> {
    while (true) {
      const next = this.messages.shift();
      if (next) { yield next; continue; }
      if (this.terminal) break;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
    await this.completed;
  }
  wait(): Promise<RunResult> { return this.completed; }
  async cancel(): Promise<void> { await this.client.call("cancel", { runId: this.id }); }
}
declare const CURSOR_WORKER_SHA256: string;
class Client {
  static async create(): Promise<Client> {
    const bytes = await readFile(new URL("./sdk-worker.mjs", import.meta.url));
    if (createHash("sha256").update(bytes).digest("hex") !== CURSOR_WORKER_SHA256) throw Error("Cursor worker digest mismatch");
    return new Client();
  }
  private worker = new Worker(new URL("./sdk-worker.mjs", import.meta.url), { stdout: true, stderr: true });
  private serial = 0;
  private dead = false;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private runs = new Map<string, StreamRun>();
  constructor() {
    this.worker.stdout?.resume(); this.worker.stderr?.resume();
    this.worker.on("message", (m) => {
      if (m.event) {
        const run = this.runs.get(m.runId);
        if (m.event === "message") run?.push(m.message);
        else run?.finish(m.result);
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
        this.runs.set(run.id, run); pending.resolve(run);
      } else pending.resolve(m.result);
    });
    this.worker.on("error", () => this.lost());
    this.worker.on("exit", () => this.lost());
  }
  private lost(): void {
    this.dead = true;
    for (const p of this.pending.values()) p.reject(Error("Cursor worker lost; outcome unknown"));
    this.pending.clear();
    for (const run of this.runs.values()) run.finish();
  }
  call(method: string, params: Record<string, string> = {}): Promise<unknown> {
    if (this.dead) return Promise.reject(Error("Cursor worker unavailable; no replay"));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.worker.postMessage({ id, method, params });
    });
  }
  async close(): Promise<void> { await this.worker.terminate(); this.lost(); }
}
export const cursorFactory: CursorFactory = {
  async hasCredentials() {
    const client = await Client.create();
    try { return await client.call("auth") === true; } finally { await client.close(); }
  },
  async models() {
    const client = await Client.create();
    try { return await client.call("models") as { id: string; name: string }[]; } finally { await client.close(); }
  },
  async create(cwd, model, stateDirectory): Promise<CursorAgent> {
    const client = await Client.create();
    try {
      const result = await client.call("create", { cwd, model, stateDirectory }) as { agentId: string };
      const close = localOwnerClose(() => client.call("close"), () => client.close());
      return { agentId: result.agentId, send: async (text) => await client.call("send", { text }) as CursorRun,
        close };
    } catch (error) { await client.close(); throw error; }
  },
};
