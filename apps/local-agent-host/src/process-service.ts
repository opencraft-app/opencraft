import { homedir } from "node:os";
import { spawn } from "node-pty";
import { createSandbox, type Sandbox, type SandboxPool } from "@opencraft/sandbox";
import { TERMINAL_RESOURCE_LIMITS, type ProcessContext, type ProcessOutput, type ProcessSnapshot } from "@opencraft/appserver-protocol";
import { validateEnvironmentName } from '../../../scripts/account-environment.js';
import type { ExecutionEnvironmentRuntime, EnvironmentExecutionScope } from '../../../scripts/execution-environment.js';

export class TerminalCapacityError extends Error {
  constructor() { super("Terminal limit reached. Close an existing terminal before creating another."); }
}
export interface PreparedProcessIdentity {
  owner?: string;
  quotaOwner: string;
  scope?: EnvironmentExecutionScope;
  env?: Record<string, string>;
}

export function prepareProcessIdentity(environment: ExecutionEnvironmentRuntime | undefined, scope: EnvironmentExecutionScope | undefined, method: string, raw: unknown, baseEnvironment: Readonly<Record<string, string | undefined>> = process.env): PreparedProcessIdentity {
  if (environment && !scope) throw new Error("Environment execution identity required");
  const snapshot = scope && environment?.snapshot(scope);
  const identity: PreparedProcessIdentity = { owner: snapshot?.owner, quotaOwner: JSON.stringify([scope?.account ?? null, scope?.hostId ?? "local"]), scope };
  if (method !== "process/spawn") return identity;
  const p = object(raw ?? {}), env: Record<string, string> = {};
  for (const [key, value] of Object.entries(snapshot?.apply(baseEnvironment) ?? baseEnvironment)) if (value !== undefined) env[key] = value;
  for (const [key, value] of Object.entries(p.env == null ? {} : object(p.env))) {
    if (snapshot) validateEnvironmentName(key);
    if (snapshot && Object.hasOwn(snapshot.overlay(), key)) throw new Error("Managed environment cannot be overridden");
    if (value === null) delete env[key];
    else if (typeof value === "string") env[key] = value;
    else throw new Error("Invalid process environment");
  }
  env.TERM = "xterm-256color";
  identity.env = env;
  return identity;
}

interface TerminalIO {
  write(data: string): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  kill(signal?: string): void | Promise<void>;
  onData(listener: (data: string | Uint8Array) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
}

interface Session {
  context: ProcessContext;
  quotaOwner: string;
  owner?: string;
  scope?: EnvironmentExecutionScope;
  pty: TerminalIO;
  sandbox?: Sandbox;
  killTimer?: ReturnType<typeof setTimeout>;
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
  constructor(private readonly environment?: ExecutionEnvironmentRuntime, private readonly sandboxPool?: SandboxPool, private readonly sandboxEnvironment: Readonly<Record<string, string>> = {}) {}
  private readonly starting = new Map<string, { controller: AbortController; identity: PreparedProcessIdentity }>();
  private readonly starts = new Set<Promise<unknown>>();
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
    return this.dispatchPrepared(method, raw, prepareProcessIdentity(this.environment, scope, method, raw, this.sandboxPool ? this.sandboxEnvironment : process.env));
  }
  /** Trusted local owner IPC only. Browser callers must use the Host admission path. */
  dispatchPrepared(method: string, raw: unknown, identity: PreparedProcessIdentity): unknown {
    if (this.closed) throw new Error("Process service is closed");
    const p = object(raw ?? {});
    const { scope, owner, quotaOwner } = identity;
    if (method === "process/list") return { processes: [...this.sessions].filter(([, s]) => s.owner === owner).map(([id, s]) => {
      const { output: _, ...metadata } = this.snapshot(id, s, s.sequence);
      return metadata;
    }) };
    if (typeof p.processHandle !== "string" || p.processHandle.length === 0 || p.processHandle.length > 256) throw new Error("Invalid process handle");
    const id = p.processHandle;
    if (method === "process/spawn") {
      if (this.sessions.has(id) || this.starting.has(id)) throw new Error("Process handle already exists");
      // Quotas are checked by the PTY owner, independently of UI connections.
      const running = [...this.sessions.values()].filter(s => s.phase === "running");
      if (running.length + this.starting.size >= TERMINAL_RESOURCE_LIMITS.activePerHost
        || running.filter(s => s.quotaOwner === quotaOwner).length + [...this.starting.values()].filter(s => s.identity.quotaOwner === quotaOwner).length >= TERMINAL_RESOURCE_LIMITS.activePerAccountHost)
        throw new TerminalCapacityError();
      if (p.resourceOwnerId != null && (typeof p.resourceOwnerId !== "string" || !p.resourceOwnerId.length || p.resourceOwnerId.length > 512))
        throw new Error("Invalid terminal resource owner");
      if (p.tty !== true || !Array.isArray(p.command) || p.command.length === 0 || !p.command.every(v => typeof v === "string" && !v.includes("\0"))) throw new Error("Expected a PTY command array");
      const dimensions = size(p.size);
      if (p.cwd != null && typeof p.cwd !== "string") throw new Error("Invalid working directory");
      if (!identity.env) throw new Error("Missing prepared process environment");
      const env = identity.env;
      if (this.sandboxPool) {
        if (typeof p.cwd !== "string" || !p.cwd) throw new Error("Sandbox terminal requires a working directory in the selected environment");
        const controller = new AbortController(); this.starting.set(id, { controller, identity });
        const operation = this.spawnSandboxed(id, p, dimensions, env, controller, identity);
        this.starts.add(operation);
        void operation.finally(() => { this.starting.delete(id); this.starts.delete(operation); }).catch(() => {});
        return operation;
      }
      const pty = spawn(p.command[0] as string, p.command.slice(1) as string[], { ...dimensions, cwd: p.cwd as string ?? homedir(), env, name: "xterm-256color" });
      return this.retain(id, pty, p, identity);

    }
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new Error("Process session not found");
    if (method === "process/attach") {
      if (!Number.isSafeInteger(p.afterSequence) || Number(p.afterSequence) < 0 || Number(p.afterSequence) > session.sequence) throw new Error("Invalid output cursor");
      return this.snapshot(id, session, Number(p.afterSequence));
    }
    if (method === "process/kill") {
      if (session.sandbox) return session.sandbox.close().then(() => ({}));
      if (session.phase === "running") this.terminate(session);
      return {};
    }
    if (session.phase !== "running") throw new Error("Process has exited");
    if (method === "process/writeStdin") {
      if (typeof p.deltaBase64 !== "string" || p.deltaBase64.length > TERMINAL_RESOURCE_LIMITS.inputBase64Bytes || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.deltaBase64)) throw new Error("Invalid stdin data");
      const written = session.pty.write(Buffer.from(p.deltaBase64, "base64").toString("utf8"));
      return written instanceof Promise ? written.then(() => ({})) : {};
    }
    if (method === "process/resizePty") {
      const { cols, rows } = size(p.size); const resized = session.pty.resize(cols, rows); return resized instanceof Promise ? resized.then(() => ({})) : {};
    }
    throw new Error(`Unsupported process method ${method}`);
  }
  private async spawnSandboxed(id: string, p: Record<string, unknown>, dimensions: { cols: number; rows: number }, env: Record<string, string>, controller: AbortController, identity: PreparedProcessIdentity) {
    const sandbox = await createSandbox(this.sandboxPool!, { owner: id, signal: controller.signal });
    try {
      if (this.closed) throw new Error("Process service is closed");
      let listener: ((data: Uint8Array) => void) | undefined;
      const buffered: Uint8Array[] = []; let bytes = 0;
      const child = await sandbox.spawn({ command: p.command as string[], cwd: p.cwd as string, env, terminal: dimensions }, output => {
        if (listener) listener(output.data);
        else {
          const data = output.data.slice(-TERMINAL_RESOURCE_LIMITS.outputBase64Bytes); buffered.push(data); bytes += data.byteLength;
          while (bytes > TERMINAL_RESOURCE_LIMITS.outputBase64Bytes) bytes -= buffered.shift()!.byteLength;
        }
      });
      if (child.kind !== "terminal") throw new Error("Sandbox backend did not provide a terminal");
      const pty: TerminalIO = {
        write: data => child.writeStdin(Buffer.from(data, "utf8")), resize: (cols, rows) => child.resize({ cols, rows }), kill: () => sandbox.close(),
        onData(callback) { listener = callback; for (const data of buffered.splice(0)) callback(data); bytes = 0; },
        onExit(callback) { void child.exited.then(exit => { callback({ exitCode: exit.code ?? -1 }); void sandbox.close().catch(() => {}); }, () => callback({ exitCode: -1 })); },
      };
      if (this.closed) throw new Error("Process service is closed");
      if (this.environment && prepareProcessIdentity(this.environment, identity.scope, "process/list", {}).owner !== identity.owner) throw new Error("Terminal execution identity changed");
      return this.retain(id, pty, p, identity, sandbox);
    } catch (error) { await sandbox.close(); throw error; }
  }
  private retain(id: string, pty: TerminalIO, p: Record<string, unknown>, identity: PreparedProcessIdentity, sandbox?: Sandbox) {
      while (this.sessions.size >= TERMINAL_RESOURCE_LIMITS.retainedPerHost) {
        const exited = [...this.sessions].find(([, s]) => s.phase === "exited");
        if (!exited) { pty.kill(); throw new TerminalCapacityError(); }
        this.sessions.delete(exited[0]);
      }
      const { scope, owner, quotaOwner } = identity;
      const context: ProcessContext = {
        resourceOwnerId: typeof p.resourceOwnerId === "string" ? p.resourceOwnerId : null,
        threadId: scope ? scope.threadId : (typeof p.threadId === "string" ? p.threadId : null),
        projectId: scope ? scope.projectId : (typeof p.projectId === "string" ? p.projectId : null),
        cwd: typeof p.cwd === "string" ? p.cwd : homedir(), shell: (p.command as string[])[0]!,
      };
      const session: Session = { context, quotaOwner, pty, scope, owner, sandbox, phase: "running", exitCode: null, sequence: 0, bytes: 0, output: [] };
      this.sessions.set(id, session);
      pty.onData(data => {
        // Individual chunks are bounded as well as the whole replay ring.
        const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
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
    await this.close();
    const deadline = Date.now() + 3000;
    while (sessions.some(session => session.phase === "running")) {
      if (Date.now() > deadline) throw new Error("Terminal owner could not drain PTYs");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  close() {
    this.closed = true;
    this.listeners.clear();
    for (const { controller } of this.starting.values()) controller.abort();
    if (this.sandboxPool) return (async () => {
      await Promise.allSettled([...this.starts]);
      const results = await Promise.allSettled([...this.sessions.values()].map(s => s.sandbox?.close()));
      this.sessions.clear();
      if (results.some(r => r.status === "rejected")) throw new Error("Host terminal sandbox cleanup is unverified");
    })();
    for (const s of this.sessions.values()) if (s.phase === "running") this.terminate(s);
    this.sessions.clear();
  }
}
