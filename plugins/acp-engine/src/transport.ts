import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { PiRpcAdapter } from "./pi-rpc.js";
import { fileURLToPath } from "node:url";
import { engineSandboxConfiguration, sandboxFileExists } from "@opencraft/sandbox-node/engine";
import { prepareSandboxInvocation } from "@opencraft/sandbox-node/command";

export type AcpObject = Record<string, any>;
export class AcpProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
export interface AcpTransportOptions {
  protocol?: "acp" | "pi-rpc";
  sandboxOwner?: string;
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  parameterizedModelPicker?: boolean;
  formElicitation?: boolean;
  redactError?: (message: string) => string;
  onNotification(method: string, params: AcpObject): void;
  onRequest(method: string, params: AcpObject, signal: AbortSignal): Promise<unknown>;
  onExit?(): void;
  onUnconfirmed?(): void;
}

/** Engine-side stdio ownership. Disconnecting a gateway never closes this pipe. */
export class AcpStdioTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer?: NodeJS.Timeout }>();
  private closing = false;
  private readonly inboundRequests = new Map<string | number, AbortController>();
  private unconfirmedRequests = 0;
  get occupancy() { return { pendingNativeRequests: this.pending.size, pendingNativeCallbacks: this.inboundRequests.size, unconfirmedNativeRequests: this.unconfirmedRequests }; }
  private initialized: Promise<AcpObject> | null = null;
  private readonly pi?: PiRpcAdapter;
  private sandboxed = false;
  constructor(private readonly options: AcpTransportOptions) {
    if (options.protocol === "pi-rpc") this.pi = new PiRpcAdapter((type, params, timeout) => this.requestNative(type, params ?? {}, timeout), options.onNotification);
  }
  get pid(): number | null { return this.child?.pid ?? null; }
  start(): Promise<AcpObject> {
    return this.initialized ??= (async () => {
      if (this.closing) throw new Error("ACP Host closed");
      const configuration = (this.pi || this.options.sandboxOwner) ? await engineSandboxConfiguration() : undefined;
      const rawEnv = { ...process.env, ...this.options.env };
      const home = rawEnv.HOME || homedir();
      const extraDirs = [dirname(process.execPath), join(home, ".local", "bin"), join(home, ".codebuddy", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
      const pathParts = (rawEnv.PATH ?? "").split(delimiter).filter(Boolean);
      for (const extra of extraDirs) if (extra && !pathParts.includes(extra)) pathParts.unshift(extra);
      const env = { ...rawEnv, PATH: pathParts.join(delimiter) };
      const bundledRunner = new URL("./sandbox-command.mjs", import.meta.url);
      const runner = configuration ? fileURLToPath(await sandboxFileExists(bundledRunner) ? bundledRunner : new URL("../../../scripts/server-deployment/sandbox-command.mjs", import.meta.url)) : undefined;
      const invocation = configuration ? prepareSandboxInvocation({ runner: runner!, configuration, owner: this.options.sandboxOwner ?? "pi-cli", cwd: this.options.cwd,
        command: [this.options.command, ...(this.options.args ?? [])], env }) : undefined;
      if (this.closing) throw new Error("ACP Host closed");
      this.sandboxed = invocation !== undefined;
      const child = spawn(invocation?.argv[0] ?? this.options.command, invocation ? invocation.argv.slice(1) : [...(this.options.args ?? [])], {
        cwd: this.options.cwd, env: invocation?.env ?? env, stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      if (invocation) child.stdin.write(invocation.input);
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
        const activeRun = this.pi?.hasActiveRun === true;
        this.child = null; lines.close();
        for (const request of this.inboundRequests.values()) request.abort();
        this.pi?.fail(new Error("Pi engine connection closed"));
        if (!this.closing && (this.pending.size || activeRun)) { this.unconfirmedRequests += this.pending.size + (activeRun ? 1 : 0); this.options.onUnconfirmed?.(); }
        for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error("ACP engine connection closed")); }
        this.pending.clear();
        if (!this.closing) this.options.onExit?.();
      };
      child.once("error", stopped); child.once("exit", stopped);
      if (this.pi) return this.pi.initialize();
      return this.request("initialize", { protocolVersion: 1,
        clientInfo: { name: "opencraft", version: "1" },
        clientCapabilities: {
          ...(this.options.parameterizedModelPicker ? { _meta: { parameterizedModelPicker: true } } : {}),
          ...(this.options.formElicitation ? { elicitation: { form: {} } } : {}),
        } });
    })();
  }
  private send(value: unknown): void {
    if (!this.child || this.closing || !this.child.stdin.writable) throw new Error("ACP engine is not connected");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  request(method: string, params: AcpObject, timeoutMs = this.options.timeoutMs ?? 30_000): Promise<any> {
    return this.pi ? this.pi.request(method, params) : this.requestNative(method, params, timeoutMs);
  }
  private requestNative(method: string, params: AcpObject, timeoutMs = this.options.timeoutMs ?? 30_000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id); this.unconfirmedRequests++; this.options.onUnconfirmed?.(); reject(new Error(`ACP ${method} outcome is unconfirmed`));
      }, timeoutMs) : undefined;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send(this.pi ? { ...params, id: String(id), type: method } : { jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  notify(method: string, params: AcpObject): void {
    if (this.pi) { if (method !== "session/cancel") throw new Error("Unsupported Pi notification"); void this.pi.cancel().catch(() => this.options.onUnconfirmed?.()); return; }
    this.send({ jsonrpc: "2.0", method, params });
  }
  private async receive(line: string): Promise<void> {
    let frame: AcpObject;
    try { frame = JSON.parse(line); } catch { throw new Error("Invalid ACP JSON"); }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid ACP frame");
    if (this.pi) {
      if (frame.type === "extension_ui_request") {
        if (frame.method === "notify" && typeof frame.message === "string" && frame.message.trim()) this.pi.event(frame);
        if (["select", "confirm", "input", "editor"].includes(frame.method) && typeof frame.id === "string") this.send({ type: "extension_ui_response", id: frame.id, cancelled: true });
      } else if (frame.type === "response") {
        const id = typeof frame.id === "string" && /^[1-9][0-9]*$/u.test(frame.id) ? Number(frame.id) : NaN;
        const call = this.pending.get(id); if (!call) return;
        this.pending.delete(id); clearTimeout(call.timer);
        frame.success === true ? call.resolve(frame.data) : call.reject(new AcpProtocolError(-32000, this.options.redactError?.(String(frame.error ?? "Pi rejected the request")) ?? String(frame.error ?? "Pi rejected the request")));
      } else this.pi.event(frame);
      return;
    }
    if (typeof frame.method === "string") {
      if (frame.id === undefined) {
        if (frame.method === "$/cancel_request") this.inboundRequests.get(frame.params?.requestId)?.abort();
        else this.options.onNotification(frame.method, frame.params ?? {});
        return;
      }
      if (typeof frame.id !== "string" && typeof frame.id !== "number") throw new Error("Invalid ACP request identity");
      if (this.inboundRequests.has(frame.id) || this.inboundRequests.size >= 256) throw new Error("Invalid ACP request admission");
      const request = new AbortController();
      this.inboundRequests.set(frame.id, request);
      try {
        const result = await this.options.onRequest(frame.method, frame.params ?? {}, request.signal);
        if (!request.signal.aborted) this.send({ jsonrpc: "2.0", id: frame.id, result });
        else if (this.options.formElicitation && frame.method === "elicitation/create" && this.child && !this.closing) {
          // Codex's cancellation notification still leaves the peer awaiting a response.
          this.send({ jsonrpc: "2.0", id: frame.id, result: { action: "cancel" } });
        }
      } catch {
        if (!request.signal.aborted) this.send({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "Host operation failed" } });
      } finally { this.inboundRequests.delete(frame.id); }
      return;
    }
    const call = this.pending.get(frame.id);
    if (!call) return;
    this.pending.delete(frame.id); clearTimeout(call.timer);
    frame.error ? call.reject(new AcpProtocolError(Number(frame.error.code), this.options.redactError?.(String(frame.error.message)) ?? String(frame.error.message), this.options.redactError ? undefined : frame.error.data)) : call.resolve(frame.result);
  }
  async close(): Promise<void> {
    if (this.closing) return;
    if (this.pi && this.child) { try { await this.pi.cancel(); } catch { /* Termination below still owns cleanup. */ } }
    this.closing = true;
    for (const request of this.inboundRequests.values()) request.abort();
    this.pi?.fail(new Error("Pi Host closed"));
    const child = this.child;
    if (!child) return;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error("ACP Host closed")); }
    this.pending.clear();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.sandboxed) reject(new Error("Agent sandbox cleanup is unconfirmed"));
        else child.kill("SIGKILL");
      }, this.sandboxed ? 15_000 : 3_000); timer.unref();
      child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
    });
  }
}
