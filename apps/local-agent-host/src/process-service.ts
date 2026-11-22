import { terminalProcessSession, drainTerminalProcessSessions, type TerminalProcessSession } from './terminal-process-session.js';
import { homedir } from "node:os";
import { spawn, type IPty } from "node-pty";
import { TERMINAL_RESOURCE_LIMITS, type ProcessContext, type ProcessOutput, type ProcessSnapshot } from "@opencraft/appserver-protocol";
import type { ExecutionEnvironmentRuntime, EnvironmentExecutionScope } from '@opencraft/execution-environment';
import { TerminalCapacityError, prepareProcessIdentity, type PreparedProcessIdentity } from './process-identity.js';

export { TerminalCapacityError, prepareProcessIdentity, type PreparedProcessIdentity } from './process-identity.js';

interface Session {
  context: ProcessContext;
  quotaOwner: string;
  owner?: string;
  scope?: EnvironmentExecutionScope;
  pty: IPty;
  killTimer?: ReturnType<typeof setTimeout>;
  processSession?: TerminalProcessSession;
  archiveStopAt?: number;
  phase: "running" | "exited";
  exitCode: number | null;
  sequence: number;
  bytes: number;
  output: ProcessOutput[];
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected process parameters");
  return value as Record<string, unknown>;
}
function size(value: unknown) {
  const p = object(value);
  for (const v of [p.cols, p.rows]) if (!Number.isInteger(v) || Number(v) < 1 || Number(v) > 1000) throw new Error("Invalid PTY size");
  return { cols: Number(p.cols), rows: Number(p.rows) };
}

/** PTY core owned by the independent terminal owner, never by a client socket. */
export class HostProcessService {
  constructor(private readonly environment?: ExecutionEnvironmentRuntime) {}
  private readonly retiredAliases = new Set<string>();
  private readonly retiredThreads = new Set<string>();
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private closed = false;
  subscribe(listener: (method: string, params: unknown) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(method: string, params: unknown) {
    for (const listener of this.listeners) listener(method, params);
  }
  dispatch(method: string, raw: unknown, scope?: EnvironmentExecutionScope): unknown {
    if (this.closed) throw new Error("Process service is closed");
    return this.dispatchPrepared(method, raw, prepareProcessIdentity(this.environment, scope, method, raw));
  }
  /** Trusted local owner IPC only. Browser callers must use the Host admission path. */
  dispatchPrepared(method: string, raw: unknown, identity: PreparedProcessIdentity): unknown {
    if (this.closed) throw new Error("Process service is closed");
    const p = object(raw ?? {});
    const { scope, owner, quotaOwner } = identity;
    const matchesScope = (session: Session) => (!scope?.threadId || session.context.threadId === scope.threadId)
      && (!scope?.projectId || session.context.projectId === scope.projectId);
    if (method === "process/threadScopes") {
      if (identity.lifecycleAuthority !== true) throw new Error("Thread inventory requires server authority");
      return [...new Map([...this.sessions.values()].filter(s => s.scope?.hostId && s.context.threadId)
        .map(s => [JSON.stringify([s.scope!.hostId, s.context.threadId]), {hostId:s.scope!.hostId,threadId:s.context.threadId!}])).values()];
    }
    if (method === "process/releaseThread") {
      if (identity.lifecycleAuthority !== true || !scope?.hostId || !scope.threadId) throw new Error("Thread cleanup requires server authority");
      const key = JSON.stringify([scope.hostId, scope.threadId]);
      const aliases = p.aliases ?? [];
      if (!Array.isArray(aliases) || aliases.length > 10000 || aliases.some(a => !a || typeof a.owner !== 'string' || typeof a.resourceOwnerId !== 'string')) throw new Error("Invalid resource aliases");
      const aliasKeys = aliases.map(a => JSON.stringify([scope.hostId, a.owner, a.resourceOwnerId]));
      if (p.activate === true) { this.retiredThreads.delete(key); for (const alias of aliasKeys) this.retiredAliases.delete(alias); return { pending: 0 }; }
      for (const alias of aliasKeys) this.retiredAliases.add(alias);
      this.retiredThreads.add(key);
      const owned = [...this.sessions.values()].filter(session => session.scope?.hostId === scope.hostId && (session.context.threadId === scope.threadId
        || !session.context.threadId && aliasKeys.includes(JSON.stringify([scope.hostId, session.owner, session.context.resourceOwnerId]))));
      for (const session of owned) {
        session.archiveStopAt ??= Date.now();
        if (session.phase === "running") this.terminate(session);
      }
      const descendants = drainTerminalProcessSessions(owned.flatMap(session => session.processSession
        ? [{ session: session.processSession, force: Date.now() - session.archiveStopAt! >= 1000 }] : []));
      return { pending: descendants + owned.filter(session => session.phase === "running").length };
    }
    if (method === "process/list") return { processes: [...this.sessions].filter(([, s]) => s.owner === owner && matchesScope(s)).map(([id, s]) => {
      const { output: _, ...metadata } = this.snapshot(id, s, s.sequence);
      return metadata;
    }) };
    if (typeof p.processHandle !== "string" || p.processHandle.length === 0 || p.processHandle.length > 256) throw new Error("Invalid process handle");
    const id = p.processHandle;
    if (method === "process/spawn") {
      if (scope?.threadId && this.retiredThreads.has(JSON.stringify([scope.hostId, scope.threadId]))) throw new Error("Conversation is archived");
      if (scope && this.retiredAliases.has(JSON.stringify([scope.hostId, owner, p.resourceOwnerId]))) throw new Error("Conversation is archived");
      if (this.sessions.has(id)) throw new Error("Process handle already exists");
      // Quotas are checked by the PTY owner, independently of UI connections.
      const running = [...this.sessions.values()].filter(s => s.phase === "running");
      if (running.length >= TERMINAL_RESOURCE_LIMITS.activePerHost
        || running.filter(s => s.quotaOwner === quotaOwner).length >= TERMINAL_RESOURCE_LIMITS.activePerAccountHost)
        throw new TerminalCapacityError();
      if (p.resourceOwnerId != null && (typeof p.resourceOwnerId !== "string" || !p.resourceOwnerId.length || p.resourceOwnerId.length > 512))
        throw new Error("Invalid terminal resource owner");
      if (p.tty !== true || !Array.isArray(p.command) || p.command.length === 0 || !p.command.every(v => typeof v === "string" && !v.includes("\0"))) throw new Error("Expected a PTY command array");
      const dimensions = size(p.size);
      if (p.cwd != null && typeof p.cwd !== "string") throw new Error("Invalid working directory");
      if (!identity.env) throw new Error("Missing prepared process environment");
      const env = identity.env;
      const pty = spawn(p.command[0] as string, p.command.slice(1) as string[], { ...dimensions, cwd: p.cwd as string ?? homedir(), env, name: "xterm-256color" });
      while (this.sessions.size >= TERMINAL_RESOURCE_LIMITS.retainedPerHost) {
        const exited = [...this.sessions].find(([, s]) => s.phase === "exited");
        if (!exited) { pty.kill(); throw new TerminalCapacityError(); }
        this.sessions.delete(exited[0]);
      }
      const context: ProcessContext = {
        resourceOwnerId: typeof p.resourceOwnerId === "string" ? p.resourceOwnerId : null,
        threadId: scope ? scope.threadId : (typeof p.threadId === "string" ? p.threadId : null),
        projectId: scope ? scope.projectId : (typeof p.projectId === "string" ? p.projectId : null),
        cwd: typeof p.cwd === "string" ? p.cwd : homedir(), shell: p.command[0] as string,
      };
      const session: Session = { context, quotaOwner, pty, scope, owner, processSession: terminalProcessSession(pty.pid), phase: "running", exitCode: null, sequence: 0, bytes: 0, output: [] };
      this.sessions.set(id, session);
      pty.onData(data => {
        // Individual chunks are bounded as well as the whole replay ring.
        const bytes = Buffer.from(data);
        for (let offset = 0; offset < bytes.length; offset += 16384) {
          const deltaBase64 = bytes.subarray(offset, offset + 16384).toString("base64");
          const chunk: ProcessOutput = { processHandle: id, sequence: ++session.sequence, stream: "stdout", deltaBase64 };
          session.output.push(chunk);
          session.bytes += deltaBase64.length;
          while (session.bytes > TERMINAL_RESOURCE_LIMITS.outputBase64Bytes) session.bytes -= session.output.shift()!.deltaBase64.length;
          this.emit("process/outputDelta", chunk);
        }
      });
      pty.onExit(({ exitCode }) => {
        session.phase = "exited"; session.exitCode = exitCode;
        clearTimeout(session.killTimer);
        this.emit("process/exited", { processHandle: id, exitCode });
      });
      return { processHandle: id };
    }
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || !matchesScope(session)) throw new Error("Process session not found");
    if (method === "process/attach") {
      if (!Number.isSafeInteger(p.afterSequence) || Number(p.afterSequence) < 0 || Number(p.afterSequence) > session.sequence) throw new Error("Invalid output cursor");
      return this.snapshot(id, session, Number(p.afterSequence));
    }
    if (method === "process/kill") {
      if (session.phase === "running") this.terminate(session);
      return {};
    }
    if (session.phase !== "running") throw new Error("Process has exited");
    if (method === "process/writeStdin") {
      if (typeof p.deltaBase64 !== "string" || p.deltaBase64.length > TERMINAL_RESOURCE_LIMITS.inputBase64Bytes || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.deltaBase64)) throw new Error("Invalid stdin data");
      session.pty.write(Buffer.from(p.deltaBase64, "base64").toString("utf8"));
      return {};
    }
    if (method === "process/resizePty") {
      const { cols, rows } = size(p.size); session.pty.resize(cols, rows); return {};
    }
    throw new Error(`Unsupported process method ${method}`);
  }
  private snapshot(id: string, session: Session, after: number): ProcessSnapshot {
    return { context: { ...session.context }, processHandle: id, phase: session.phase, exitCode: session.exitCode,
      output: session.output.filter(chunk => chunk.sequence > after), nextSequence: session.sequence,
      truncated: after < (session.output[0]?.sequence ?? session.sequence + 1) - 1 };
  }
  private terminate(session: Session) {
    if (session.killTimer) return;
    session.pty.kill();
    // A shell may ignore HUP (including during startup). Explicit termination
    // must eventually release its PTY and active quota, rather than stay live.
    session.killTimer = setTimeout(() => {
      if (session.phase === "running") { try { session.pty.kill("SIGKILL"); } catch {} }
    }, 1000);
    session.killTimer.unref();
  }
  async shutdown() {
    const sessions = [...this.sessions.values()];
    this.close();
    const started = Date.now(), deadline = started + 3000;
    for (;;) {
      const descendants = drainTerminalProcessSessions(sessions.flatMap(session => session.processSession
        ? [{ session: session.processSession, force: Date.now() - started >= 1000 }] : []));
      if (!descendants && !sessions.some(session => session.phase === "running")) return;
      if (Date.now() > deadline) throw new Error("Terminal owner could not drain PTYs");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  close() {
    this.closed = true;
    this.listeners.clear();
    for (const s of this.sessions.values()) if (s.phase === "running") this.terminate(s);
    this.sessions.clear();
  }
}
