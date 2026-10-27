import { homedir } from "node:os";
import { spawn, type IPty } from "node-pty";
import type { ProcessOutput, ProcessSnapshot } from "@opencraft/appserver-protocol";

interface Session {
  pty: IPty;
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

/** Owned by the authenticated local Host, never by a socket or an Agent adapter. */
export class HostProcessService {
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
  dispatch(method: string, raw: unknown): unknown {
    if (this.closed) throw new Error("Process service is closed");
    const p = object(raw ?? {});
    if (method === "process/list") return { processes: [...this.sessions].map(([id, s]) => {
      const { output: _, ...metadata } = this.snapshot(id, s, s.sequence);
      return metadata;
    }) };
    if (typeof p.processHandle !== "string" || p.processHandle.length === 0 || p.processHandle.length > 256) throw new Error("Invalid process handle");
    const id = p.processHandle;
    if (method === "process/spawn") {
      if (this.sessions.has(id)) throw new Error("Process handle already exists");
      // Bound both running processes and retained exit/output history.
      if (this.sessions.size >= 64) {
        const exited = [...this.sessions].find(([, s]) => s.phase === "exited");
        if (exited) this.sessions.delete(exited[0]);
        else throw new Error("Host terminal limit reached");
      }
      if (p.tty !== true || !Array.isArray(p.command) || p.command.length === 0 || !p.command.every(v => typeof v === "string" && !v.includes("\0"))) throw new Error("Expected a PTY command array");
      const dimensions = size(p.size);
      if (p.cwd != null && typeof p.cwd !== "string") throw new Error("Invalid working directory");
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
      for (const [key, value] of Object.entries(p.env == null ? {} : object(p.env))) {
        if (value === null) delete env[key];
        else if (typeof value === "string") env[key] = value;
        else throw new Error("Invalid process environment");
      }
      env.TERM = "xterm-256color";
      const pty = spawn(p.command[0] as string, p.command.slice(1) as string[], { ...dimensions, cwd: p.cwd as string ?? homedir(), env, name: "xterm-256color" });
      const session: Session = { pty, phase: "running", exitCode: null, sequence: 0, bytes: 0, output: [] };
      this.sessions.set(id, session);
      pty.onData(data => {
        // Individual chunks are bounded as well as the whole replay ring.
        const bytes = Buffer.from(data);
        for (let offset = 0; offset < bytes.length; offset += 16384) {
          const deltaBase64 = bytes.subarray(offset, offset + 16384).toString("base64");
          const chunk: ProcessOutput = { processHandle: id, sequence: ++session.sequence, stream: "stdout", deltaBase64 };
          session.output.push(chunk);
          session.bytes += deltaBase64.length;
          while (session.bytes > 1024 * 1024) session.bytes -= session.output.shift()!.deltaBase64.length;
          this.emit("process/outputDelta", chunk);
        }
      });
      pty.onExit(({ exitCode }) => {
        session.phase = "exited"; session.exitCode = exitCode;
        this.emit("process/exited", { processHandle: id, exitCode });
      });
      return { processHandle: id };
    }
    const session = this.sessions.get(id);
    if (!session) throw new Error("Process session not found");
    if (method === "process/attach") {
      if (!Number.isSafeInteger(p.afterSequence) || Number(p.afterSequence) < 0 || Number(p.afterSequence) > session.sequence) throw new Error("Invalid output cursor");
      return this.snapshot(id, session, Number(p.afterSequence));
    }
    if (method === "process/kill") {
      if (session.phase === "running") session.pty.kill();
      return {};
    }
    if (session.phase !== "running") throw new Error("Process has exited");
    if (method === "process/writeStdin") {
      if (typeof p.deltaBase64 !== "string" || p.deltaBase64.length > 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.deltaBase64)) throw new Error("Invalid stdin data");
      session.pty.write(Buffer.from(p.deltaBase64, "base64").toString("utf8"));
      return {};
    }
    if (method === "process/resizePty") {
      const { cols, rows } = size(p.size); session.pty.resize(cols, rows); return {};
    }
    throw new Error(`Unsupported process method ${method}`);
  }
  private snapshot(id: string, session: Session, after: number): ProcessSnapshot {
    return { processHandle: id, phase: session.phase, exitCode: session.exitCode,
      output: session.output.filter(chunk => chunk.sequence > after), nextSequence: session.sequence,
      truncated: after < (session.output[0]?.sequence ?? session.sequence + 1) - 1 };
  }
  close() {
    this.closed = true;
    this.listeners.clear();
    for (const s of this.sessions.values()) if (s.phase === "running") s.pty.kill();
    this.sessions.clear();
  }
}
