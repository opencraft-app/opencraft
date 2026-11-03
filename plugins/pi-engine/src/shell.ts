import { sandboxMessage } from "@opencraft/sandbox-node/command";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { engineSandboxConfiguration } from "@opencraft/sandbox-node/engine";
import { prepareSandboxInvocation } from "@opencraft/sandbox-node/command";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import type { ExecutionEnvironmentSnapshot } from '../../../scripts/execution-environment.js';

export type ShellRecord = { id: string; state: "running" | "completed" | "interrupted"; command: string;
  output: string; detached: boolean; isError?: boolean; rawOutput?: string; truncated?: boolean; exitCode?: number | null; createdAtMs: number; notified?: boolean; turnId?: string; generation: string; environmentOwner?: string; monitorEvents?: { id: number; content: string; createdAtMs: number }[] };
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
  constructor(private readonly options: { cwd: string; directory: string; threadId: string; environment?: ExecutionEnvironmentSnapshot;
    onNotification(message: Record<string, any>): void; onLost(generation: string): void }) {}
  get pid() { return this.child?.pid; }
  async start(): Promise<{ parameters: Record<string, any> }> {
    const configuration = await engineSandboxConfiguration();
    return this.starting ??= new Promise((resolve, reject) => {
      this.intentional = false; this.stopping = undefined; this.generation = randomUUID();
      const bundled = new URL("./pi-shell-worker.mjs", import.meta.url);
      const entry = existsSync(bundled) ? bundled : new URL("./shell-worker.ts", import.meta.url);
      const workerArgs = [JSON.stringify({ cwd: this.options.cwd, directory: this.options.directory })];
      const execArgv = entry.pathname.endsWith(".ts") ? ["--import", "tsx"] : [];
      const env = { ...(this.options.environment?.apply(process.env) ?? process.env), OPENCRAFT_THREAD_ID: this.options.threadId, PI_CODING_AGENT_DIR: this.options.directory };
      const bundledRunner = new URL("./sandbox-command.mjs", import.meta.url);
      const runner = fileURLToPath(existsSync(bundledRunner) ? bundledRunner : new URL("../../../scripts/server-deployment/sandbox-command.mjs", import.meta.url));
      const invocation = configuration ? prepareSandboxInvocation({ runner, configuration, owner: "pi", cwd: this.options.cwd,
        command: [process.execPath, ...execArgv, fileURLToPath(entry), ...workerArgs, "--stdio"], env }) : undefined;
      const child = this.child = invocation ? spawn(invocation.argv[0]!, invocation.argv.slice(1), {
        cwd: this.options.cwd, env: invocation.env, stdio: ["pipe", "pipe", "inherit"],
      }) : fork(entry, workerArgs, { stdio: ["ignore", "ignore", "inherit", "ipc"], env, execArgv });
      child.once("close", () => invocation?.dispose()); child.once("error", () => invocation?.dispose());
      const deadline = setTimeout(() => { reject(new Error("Pi shell worker did not initialize")); void this.stop(); }, 30_000);
      const message = (message: any) => {
        if (message?.type === "ready") { clearTimeout(deadline); resolve({ parameters: message.parameters }); }
        else if (message?.type === "notification" && !this.intentional) this.options.onNotification(message);
        else if (message?.type === "fault" && !this.intentional) { this.options.onLost(this.generation); void this.stop(); }
        else if (message?.type === "result") {
          const request = this.pending.get(message.id); this.pending.delete(message.id); request?.resolve(message.result);
        }
      };
      if (invocation) {
        const lines = createInterface({ input: child.stdout! });
        let bytes = 0;
        child.stdout!.on("data", chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) child.kill("SIGTERM"); });
        lines.on("line", text => { bytes = 0; try { message(JSON.parse(text)); } catch { child.kill("SIGTERM"); } });
        child.once("close", () => lines.close());
      } else child.on("message", message);
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
    if (signal?.aborted || !(this.child?.connected || this.child?.stdin?.writable)) throw new Error("Pi shell call cancelled");
    const id = ++this.next;
    const cancel = () => { void this.stop(); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await new Promise<ShellResult>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.send(this.child!, { type: "call", id, args }, error => {
          if (error) { this.pending.delete(id); reject(new Error("Pi shell IPC failed")); }
        });
      });
    } finally { signal?.removeEventListener("abort", cancel); }
  }
  private send(child: ChildProcess, message: unknown, callback: (error: Error | null) => void) {
    if (child.connected) child.send(message as object, callback);
    else if (child.stdin?.writable) child.stdin.write(sandboxMessage(message), error => callback(error ?? null));
    else callback(new Error("Pi shell transport unavailable"));
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
      const deadline = setTimeout(() => { child.kill("SIGKILL"); }, 15000);
      child.once("exit", finish); child.once("error", finish);
      if (child.connected || child.stdin?.writable) this.send(child, { type: "close" }, error => { if (error) child.kill("SIGTERM"); });
      else child.kill("SIGTERM");
    });
  }
}
