import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";

export type ShellRecord = { id: string; state: "running" | "completed" | "interrupted"; command: string;
  output: string; detached: boolean; isError?: boolean; rawOutput?: string; truncated?: boolean; exitCode?: number | null; createdAtMs: number; notified?: boolean; turnId?: string; generation: string };
export const PiShellDoc = defineDoc<{ records: ShellRecord[]; paused: boolean }>({
  kind: "opencraft.piShell", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ records: [], paused: false }),
});
export type ShellResult = { content?: { type: string; text?: string }[]; isError?: boolean; details?: Record<string, any> };
export const shellText = (result: ShellResult) => (result.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
export const shellDescription = "Run and control a managed background PTY in this conversation. Returns a sessionId immediately, freeing the next step for user steering. Use mode dispatch and background true for commands; query with sessionId, send input/inputKeys, or kill with sessionId. Completion is delivered automatically. Interactive TUI overlays and CLI slash commands are unavailable in this headless host. Sessions stop on user Stop or owner loss and are never replayed after restart.";

/** A lazy, isolated CLI extension runtime. No model credentials or user messages cross its IPC. */
export class PiShellWorker {
  generation = randomUUID();
  private child?: ChildProcess;
  private starting?: Promise<{ parameters: Record<string, any> }>;
  private next = 0;
  private pending = new Map<number, { resolve(result: ShellResult): void; reject(error: Error): void }>();
  private stopping?: Promise<void>;
  private intentional = false;
  constructor(private readonly options: { cwd: string; directory: string; threadId: string;
    onNotification(message: Record<string, any>): void; onLost(generation: string): void }) {}
  async start(): Promise<{ parameters: Record<string, any> }> {
    return this.starting ??= new Promise((resolve, reject) => {
      this.intentional = false; this.stopping = undefined; this.generation = randomUUID();
      const bundled = new URL("./pi-shell-worker.mjs", import.meta.url);
      const entry = existsSync(bundled) ? bundled : new URL("./shell-worker.ts", import.meta.url);
      const child = this.child = fork(entry, [JSON.stringify({ cwd: this.options.cwd, directory: this.options.directory })], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        env: { ...process.env, OPENCRAFT_THREAD_ID: this.options.threadId, PI_CODING_AGENT_DIR: this.options.directory },
        execArgv: entry.pathname.endsWith(".ts") ? ["--import", "tsx"] : [],
      });
      const deadline = setTimeout(() => { reject(new Error("Pi shell worker did not initialize")); void this.stop(); }, 30_000);
      child.on("message", (message: any) => {
        if (message?.type === "ready") { clearTimeout(deadline); resolve({ parameters: message.parameters }); }
        else if (message?.type === "notification" && !this.intentional) this.options.onNotification(message);
        else if (message?.type === "fault" && !this.intentional) { this.options.onLost(this.generation); void this.stop(); }
        else if (message?.type === "result") {
          const request = this.pending.get(message.id); this.pending.delete(message.id); request?.resolve(message.result);
        }
      });
      const lost = () => {
        clearTimeout(deadline); reject(new Error("Pi shell worker exited"));
        for (const request of this.pending.values()) request.reject(new Error("Pi shell worker exited"));
        this.pending.clear();
        if (this.child === child) { this.child = undefined; this.starting = undefined; }
        if (!this.intentional) this.options.onLost(this.generation);
      };
      child.once("exit", lost); child.once("error", lost);
    });
  }
  async call(args: Record<string, any>, signal?: AbortSignal): Promise<ShellResult> {
    if (signal?.aborted) throw new Error("Pi shell call cancelled");
    await this.start();
    if (signal?.aborted || !this.child?.connected) throw new Error("Pi shell call cancelled");
    const id = ++this.next;
    const cancel = () => { void this.stop(); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await new Promise<ShellResult>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.child!.send({ type: "call", id, args }, error => {
          if (error) { this.pending.delete(id); reject(new Error("Pi shell IPC failed")); }
        });
      });
    } finally { signal?.removeEventListener("abort", cancel); }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.intentional = true;
    const child = this.child;
    if (!child) { this.starting = undefined; return Promise.resolve(); }
    return this.stopping = new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true; clearTimeout(deadline);
        if (this.child === child) { this.child = undefined; this.starting = undefined; }
        resolve();
      };
      const deadline = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
      child.once("exit", finish); child.once("error", finish);
      if (child.connected) child.send({ type: "close" }, error => { if (error) child.kill("SIGTERM"); });
      else child.kill("SIGTERM");
    });
  }
}
