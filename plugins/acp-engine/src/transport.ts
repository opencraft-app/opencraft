import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type AcpObject = Record<string, any>;
export class AcpProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
export interface AcpTransportOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onNotification(method: string, params: AcpObject): void;
  onRequest(method: string, params: AcpObject): Promise<unknown>;
  onExit?(): void;
}

/** Engine-side stdio ownership. Disconnecting a gateway never closes this pipe. */
export class AcpStdioTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer?: NodeJS.Timeout }>();
  private closing = false;
  private initialized: Promise<AcpObject> | null = null;
  constructor(private readonly options: AcpTransportOptions) {}
  get pid(): number | null { return this.child?.pid ?? null; }
  start(): Promise<AcpObject> {
    return this.initialized ??= (async () => {
      if (this.closing) throw new Error("ACP Host closed");
      const child = spawn(this.options.command, [...(this.options.args ?? [])], {
        cwd: this.options.cwd, env: { ...process.env, ...this.options.env }, stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      // Diagnostics are deliberately not forwarded: protocol peers may include
      // credentials or prompt content in their stderr.
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", line => {
        if (Buffer.byteLength(line) > 32 * 1024 * 1024) { child.kill(); return; }
        void this.receive(line).catch(() => child.kill());
      });
      const stopped = () => {
        if (this.child !== child) return;
        this.child = null; lines.close();
        for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error("ACP engine connection closed")); }
        this.pending.clear();
        if (!this.closing) this.options.onExit?.();
      };
      child.once("error", stopped); child.once("exit", stopped);
      return this.request("initialize", { protocolVersion: 1,
        clientInfo: { name: "opencraft", version: "1" }, clientCapabilities: {} });
    })();
  }
  private send(value: unknown): void {
    if (!this.child || this.closing || !this.child.stdin.writable) throw new Error("ACP engine is not connected");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  request(method: string, params: AcpObject, timeoutMs = this.options.timeoutMs ?? 30_000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id); reject(new Error(`ACP ${method} outcome is unconfirmed`));
      }, timeoutMs) : undefined;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  notify(method: string, params: AcpObject): void { this.send({ jsonrpc: "2.0", method, params }); }
  private async receive(line: string): Promise<void> {
    let frame: AcpObject;
    try { frame = JSON.parse(line); } catch { throw new Error("Invalid ACP JSON"); }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid ACP frame");
    if (typeof frame.method === "string") {
      if (frame.id === undefined) { this.options.onNotification(frame.method, frame.params ?? {}); return; }
      try { this.send({ jsonrpc: "2.0", id: frame.id, result: await this.options.onRequest(frame.method, frame.params ?? {}) }); }
      catch { this.send({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "Host operation failed" } }); }
      return;
    }
    const call = this.pending.get(frame.id);
    if (!call) return;
    this.pending.delete(frame.id); clearTimeout(call.timer);
    frame.error ? call.reject(new AcpProtocolError(Number(frame.error.code), String(frame.error.message), frame.error.data)) : call.resolve(frame.result);
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child) return;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error("ACP Host closed")); }
    this.pending.clear();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000); timer.unref();
      child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
    });
  }
}
