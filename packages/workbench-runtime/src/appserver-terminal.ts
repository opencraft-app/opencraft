import type { AppServerClient } from "@opencraft/appserver-client";
import type { ProcessOutput, ProcessSnapshot } from "@opencraft/appserver-protocol";

export type AppServerTerminalPhase = "starting" | "running" | "stopping" | "exited" | "failed" | "disconnected";
export interface AppServerTerminalOutputChunk {
  readonly sequence: number;
  readonly stream: "stdout" | "stderr";
  readonly deltaBase64: string;
}
export interface AppServerTerminalSnapshot {
  readonly revision: number;
  readonly hostId: string;
  readonly processId: string;
  readonly connectionGeneration: number;
  readonly phase: AppServerTerminalPhase;
  readonly output: readonly AppServerTerminalOutputChunk[];
  readonly exitCode: number | null;
  readonly error: Error | null;
}
export interface OpenAppServerTerminalOptions {
  readonly command: readonly string[];
  readonly cwd?: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly env?: Readonly<Record<string, string | null>>;
}
export interface AppServerTerminalSession {
  readonly processId: string;
  getSnapshot(): AppServerTerminalSnapshot;
  subscribe(listener: () => void): () => void;
  write(deltaBase64: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  terminate(): Promise<void>;
  /** Releases the observer, not the Host-owned process. */
  dispose(): Promise<void>;
}
export interface AppServerTerminalResourcePort {
  open(options: OpenAppServerTerminalOptions): AppServerTerminalSession;
  attach(processId: string): AppServerTerminalSession;
  list(): Promise<{ processes: Array<Omit<ProcessSnapshot, "output">> }>;
}
interface Session {
  snapshot: AppServerTerminalSnapshot;
  listeners: Set<() => void>;
  ready: Promise<void>;
  disposed: boolean;
  cursor: number;
  buffered: ProcessOutput[] | null;
}
const errorFrom = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause));
function cell(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new RangeError("Invalid terminal dimensions");
  return value;
}

/** Client projections of Host-owned PTYs; socket disposal never kills a process. */
export class AppServerTerminalController implements AppServerTerminalResourcePort {
  private readonly sessions = new Map<string, Session>();
  private readonly unsubscribe: Array<() => void>;
  private disposed = false;
  constructor(private readonly hostId: string, private readonly client: AppServerClient,
    private readonly replayBase64Limit = 4 * 1024 * 1024) {
    this.unsubscribe = [client.subscribeNotification(notification => {
      const params = notification.params as ProcessOutput & { exitCode: number };
      const session = this.sessions.get(params?.processHandle);
      if (!session) return;
      if (notification.method === "process/outputDelta") {
        if (session.buffered !== null) session.buffered.push(params);
        else this.output(session, [params]);
      }
      if (notification.method === "process/exited") this.update(session, { phase: "exited", exitCode: params.exitCode });
    }), client.subscribeStatus(status => {
      for (const session of this.sessions.values()) {
        if (status.state === "closed" || status.state === "failed") {
          session.buffered = [];
          if (session.snapshot.phase !== "exited") this.update(session, { phase: "disconnected", error: new Error(status.reason ?? "Host disconnected") });
        }
      }
    })];
  }
  list() { return this.client.request("process/list", {}); }
  /** Called after AppServer initialize, not merely after the transport opens. */
  async reconnect() {
    await Promise.allSettled([...this.sessions].filter(([, s]) => s.snapshot.phase === "disconnected").map(([id, s]) => {
      s.ready = this.sync(id, s);
      return s.ready;
    }));
  }
  open(options: OpenAppServerTerminalOptions): AppServerTerminalSession {
    if (!options.command.length) throw new Error("Terminal command must not be empty");
    const size = { cols: cell(options.cols), rows: cell(options.rows) };
    const id = "opencraft-terminal:" + crypto.randomUUID();
    const session = this.create(id);
    const generation = this.client.connectionGeneration;
    session.ready = this.client.request("process/spawn", {
      processHandle: id, command: [...options.command], tty: true, size,
      streamStdoutStderr: true, outputBytesCap: null, timeoutMs: null,
      cwd: options.cwd, env: options.env === undefined ? undefined : { ...options.env },
    }).then(() => {
      if (generation === this.client.connectionGeneration && session.snapshot.phase === "starting") this.update(session, { phase: "running" });
    }).catch(cause => {
      if (generation === this.client.connectionGeneration && session.snapshot.phase !== "disconnected") this.update(session, { phase: "failed", error: errorFrom(cause) });
      throw cause;
    });
    void session.ready.catch(() => undefined);
    return this.handle(id, session);
  }
  attach(id: string): AppServerTerminalSession {
    if (this.sessions.has(id)) throw new Error("Process already attached to this controller");
    const session = this.create(id);
    session.ready = this.sync(id, session);
    void session.ready.catch(() => undefined);
    return this.handle(id, session);
  }
  private create(id: string): Session {
    if (this.disposed || this.client.status.state !== "open") throw new Error("Terminal Host is not connected");
    const session: Session = { snapshot: Object.freeze({ revision: 0, hostId: this.hostId, processId: id,
      connectionGeneration: this.client.connectionGeneration, phase: "starting", output: [], exitCode: null, error: null }),
      listeners: new Set(), ready: Promise.resolve(), disposed: false, cursor: 0, buffered: null };
    this.sessions.set(id, session);
    return session;
  }
  private async sync(id: string, session: Session) {
    const generation = this.client.connectionGeneration;
    const afterSequence = session.cursor;
    session.buffered = [];
    try {
      const result = await this.client.request("process/attach", { processHandle: id, afterSequence });
      if (generation !== this.client.connectionGeneration || session.disposed) return;
      this.output(session, [...result.output, ...session.buffered ?? []]);
      session.buffered = null;
      session.cursor = Math.max(session.cursor, result.nextSequence);
      this.update(session, { phase: session.snapshot.phase === "exited" ? "exited" : result.phase,
        exitCode: session.snapshot.exitCode ?? result.exitCode, connectionGeneration: generation,
        error: result.truncated ? new Error("Some terminal output expired while disconnected") : null });
    } catch (cause) {
      if (generation === this.client.connectionGeneration) this.update(session, { phase: "disconnected", error: errorFrom(cause) });
      throw cause;
    }
  }
  private handle(id: string, session: Session): AppServerTerminalSession {
    const live = async () => {
      await session.ready;
      if (session.disposed || this.client.status.state !== "open" || session.snapshot.phase !== "running") throw new Error("Terminal is not accepting input");
    };
    return { processId: id, getSnapshot: () => session.snapshot,
      subscribe: listener => { session.listeners.add(listener); return () => session.listeners.delete(listener); },
      write: async deltaBase64 => { await live(); await this.client.request("process/writeStdin", { processHandle: id, deltaBase64 }); },
      resize: async (cols, rows) => { const size = { cols: cell(cols), rows: cell(rows) }; await live(); await this.client.request("process/resizePty", { processHandle: id, size }); },
      terminate: async () => {
        await session.ready;
        if (session.snapshot.phase === "exited") return;
        await live(); this.update(session, { phase: "stopping" });
        try { await this.client.request("process/kill", { processHandle: id }); }
        catch (cause) { this.update(session, { phase: "disconnected", error: errorFrom(cause) }); throw cause; }
      },
      dispose: async () => { session.disposed = true; session.listeners.clear(); this.sessions.delete(id); },
    };
  }
  async dispose() {
    this.disposed = true;
    this.unsubscribe.forEach(remove => remove());
    for (const s of this.sessions.values()) { s.disposed = true; s.listeners.clear(); }
    this.sessions.clear();
  }
  private output(session: Session, chunks: readonly ProcessOutput[]) {
    const merged = new Map(session.snapshot.output.map(chunk => [chunk.sequence, chunk]));
    for (const chunk of chunks) merged.set(chunk.sequence, chunk);
    const output = [...merged.values()].sort((a, b) => a.sequence - b.sequence);
    let bytes = output.reduce((sum, chunk) => sum + chunk.deltaBase64.length, 0);
    while (output.length > 1 && bytes > this.replayBase64Limit) bytes -= output.shift()!.deltaBase64.length;
    if (session.snapshot.phase === "running") session.cursor = Math.max(session.cursor, output.at(-1)?.sequence ?? 0);
    this.update(session, { output: Object.freeze(output) });
  }
  private update(session: Session, patch: Partial<AppServerTerminalSnapshot>) {
    if (session.disposed) return;
    session.snapshot = Object.freeze({ ...session.snapshot, ...patch, revision: session.snapshot.revision + 1 });
    session.listeners.forEach(listener => listener());
  }
}
