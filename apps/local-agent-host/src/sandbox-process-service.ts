import { posix } from "node:path";
import type { SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";
import { TERMINAL_RESOURCE_LIMITS as limits, type ProcessContext, type ProcessOutput, type ProcessSnapshot } from "@opencraft/appserver-protocol";

type Terminal = Extract<SandboxProcess, { kind: "terminal" }>;
type Session = { child?: Terminal; ready: boolean; context: ProcessContext; phase: "running" | "exited"; exitCode: number | null; sequence: number; bytes: number; output: ProcessOutput[] };
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid process parameters");
  return value;
};
const size = (value: unknown) => {
  const p = object(value);
  if (![p.cols, p.rows].every(v => Number.isInteger(v) && v > 0 && v <= 1000)) throw Error("Invalid PTY size");
  return { cols: p.cols as number, rows: p.rows as number };
};
/** Existing Web process protocol over one authorized remote binding. No local PTY,
 * process.env, or resource lookup by client-supplied thread metadata. Host admission
 * retains the aggregate account/Host quota; this service additionally bounds each
 * binding. Host event subscribers must perform their usual per-client authorization.
 * Replay survives socket detach, not destruction/replacement of this incarnation. */
export class SandboxProcessService {
  private closed = false;
  private cleanupFailed = false;
  private closing?: Promise<void>;
  private sessions = new Map<string, Session>();
  private pending = new Set<Promise<unknown>>();
  private listeners = new Set<(method: string, params: unknown) => void>();
  constructor(private readonly options: {
    sandbox: Pick<SandboxEnvironment, "spawn">;
    cwd: string;
    context: Pick<ProcessContext, "threadId" | "projectId" | "resourceOwnerId">;
    authorize(): Promise<void>;
    onCleanupUnconfirmed(): void;
  }) {}
  async probe(): Promise<void> { await this.authorize(); }
  /** HostTerminalSession calls this only after its trusted binding selector has
   * authorized the account/Host. Scope metadata cannot select another service. */
  async dispatch(method: string, params: unknown,
    scope?: { threadId: string | null; projectId: string | null },
    assertCurrent?: () => void, onAccepted?: () => void): Promise<unknown> {
    if (!scope || scope.threadId !== this.options.context.threadId || scope.projectId !== this.options.context.projectId)
      throw Error("Process scope mismatch");
    assertCurrent?.();
    const result = await this.request(method, params);
    try { assertCurrent?.(); onAccepted?.(); }
    catch (error) {
      if (method === "process/spawn") {
        const child = this.sessions.get(object(params).processHandle)?.child;
        try { await child?.terminate(); }
        catch { this.cleanupFailed = true; this.options.onCleanupUnconfirmed(); }
      }
      throw error;
    }
    // Output may arrive before spawn acknowledges. Install the authorized watch
    // first, then replay the bounded ring without another asynchronous gap.
    if (method === "process/spawn") {
      const id = object(params).processHandle, session = this.sessions.get(id);
      if (session?.ready) {
        for (const chunk of session.output) this.emit("process/outputDelta", { ...chunk });
        if (session.phase === "exited") this.emit("process/exited", { processHandle: id, exitCode: session.exitCode });
      }
    }
    return result;
  }
  subscribe(listener: (method: string, params: unknown) => void) {
    if (this.closed) throw Error("Sandbox process service closed");
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private emit(method: string, params: unknown) {
    if (!this.closed) for (const listener of this.listeners) { try { listener(method, params); } catch {} }
  }
  private async authorize() {
    if (this.closed) throw Error("Sandbox process service closed");
    await this.options.authorize();
    if (this.closed) throw Error("Sandbox process service closed");
  }
  private snapshot(id: string, s: Session, after: number): ProcessSnapshot {
    return { processHandle: id, context: { ...s.context }, phase: s.phase, exitCode: s.exitCode,
      nextSequence: s.sequence, output: s.output.filter(c => c.sequence > after).map(c => ({ ...c })),
      truncated: after < (s.output[0]?.sequence ?? s.sequence + 1) - 1 };
  }
  async request(method: string, raw: unknown): Promise<unknown> {
    await this.authorize();
    const p = object(raw ?? {});
    for (const key of ["threadId", "projectId", "resourceOwnerId"] as const)
      if (p[key] != null && p[key] !== this.options.context[key]) throw Error("Process scope mismatch");
    if (method === "process/list") return { processes: [...this.sessions].filter(([, s]) => s.ready).map(([id, s]) => {
      const { output: _, ...metadata } = this.snapshot(id, s, s.sequence); return metadata;
    }) };
    if (typeof p.processHandle !== "string" || !p.processHandle.length || p.processHandle.length > 256) throw Error("Invalid process handle");
    const id: string = p.processHandle;
    if (method === "process/spawn") {
      if (this.sessions.has(id)) throw Error("Process handle already exists");
      if (p.tty !== true || !Array.isArray(p.command) || !p.command.length || p.command.length > 256
        || p.command.some((v: unknown) => typeof v !== "string" || v.includes("\0"))) throw Error("Expected a PTY command array");
      // Only the bound cwd is supported until directory admission is implemented.
      if (p.cwd != null && (typeof p.cwd !== "string" || posix.normalize(p.cwd) !== this.options.cwd)) throw Error("Process cwd is outside binding");
      const dimensions = size(p.size), env: Record<string, string> = { TERM: "xterm-256color" };
      for (const [key, value] of Object.entries(p.env == null ? {} : object(p.env))) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) throw Error("Invalid sandbox environment");
        env[key] = value;
      }
      if ([...this.sessions.values()].filter(s => s.phase === "running").length >= limits.activePerAccountHost) throw Error("Terminal limit reached");
      if (this.sessions.size >= limits.retainedPerHost) {
        const evict = [...this.sessions].find(([, s]) => s.ready && s.phase === "exited");
        if (!evict) throw Error("Terminal limit reached"); this.sessions.delete(evict[0]);
      }
      const session: Session = { ready: false, context: { ...this.options.context, cwd: this.options.cwd, shell: p.command[0] }, phase: "running", exitCode: null, sequence: 0, bytes: 0, output: [] };
      this.sessions.set(id, session); // Reserve before async launch, including duplicate handles.
      const launch = (async () => {
        let child: SandboxProcess | undefined;
        try {
          child = await this.options.sandbox.spawn({ command: [...p.command], cwd: this.options.cwd, env, terminal: dimensions }, event => {
            if (this.closed) return;
            const data = Buffer.from(event.data);
            for (let at = 0; at < data.length; at += 16384) {
              const chunk: ProcessOutput = { processHandle: id, sequence: ++session.sequence, stream: event.stream, deltaBase64: data.subarray(at, at + 16384).toString("base64") };
              session.output.push(chunk); session.bytes += chunk.deltaBase64.length;
              while (session.bytes > limits.outputBase64Bytes) session.bytes -= session.output.shift()!.deltaBase64.length;
              if (session.ready) this.emit("process/outputDelta", { ...chunk });
            }
          });
          if (child.kind !== "terminal") throw Error("Remote terminal unavailable");
          await this.authorize();
          session.child = child; session.ready = true;
          for (const chunk of session.output) this.emit("process/outputDelta", { ...chunk });
          void child.exited.then(exit => {
            session.phase = "exited"; session.exitCode = exit.code;
            this.emit("process/exited", { processHandle: id, exitCode: exit.code });
          }, () => { this.cleanupFailed = true; this.options.onCleanupUnconfirmed(); void this.close().catch(() => {}); });
          return { processHandle: id };
        } catch (error) {
          if (child) try { await child.terminate(); } catch { this.cleanupFailed = true; this.options.onCleanupUnconfirmed(); }
          this.sessions.delete(id); throw error;
        }
      })();
      this.pending.add(launch);
      try { return await launch; } finally { this.pending.delete(launch); }
    }
    const s = this.sessions.get(id);
    if (!s?.ready || !s.child) throw Error("Process session not found");
    if (method === "process/attach") {
      if (!Number.isSafeInteger(p.afterSequence) || p.afterSequence < 0 || p.afterSequence > s.sequence) throw Error("Invalid output cursor");
      return this.snapshot(id, s, p.afterSequence);
    }
    if (method === "process/kill") { if (s.phase === "running") await s.child.terminate(); return {}; }
    if (s.phase !== "running") throw Error("Process has exited");
    if (method === "process/writeStdin") {
      if (typeof p.deltaBase64 !== "string" || p.deltaBase64.length > limits.inputBase64Bytes || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.deltaBase64)) throw Error("Invalid stdin data");
      await s.child.writeStdin(Buffer.from(p.deltaBase64, "base64")); return {};
    }
    if (method === "process/resizePty") { await s.child.resize(size(p.size)); return {}; }
    throw Error("Unsupported sandbox process method");
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; this.listeners.clear();
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled([...this.sessions.values()].filter(s => s.phase === "running" && s.child).map(s => s.child!.terminate()));
      this.sessions.clear();
      if (this.cleanupFailed || results.some(r => r.status === "rejected")) { this.cleanupFailed = true; this.options.onCleanupUnconfirmed(); throw Error("Remote terminal cleanup unconfirmed"); }
    })();
  }
}
