import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { AgyChannel, AGY_PROBE } from "./agy";
import { DshChannel } from "./dsh";
/**
 * Minimal, bounded ACP (Agent Client Protocol) client over stdio.
 *
 * This is deliberately not a general SDK wrapper: OpenCraft owns the bridge,
 * and the bridge only needs initialize, session creation, prompt, cancel,
 * session mode/config selection and inbound permission requests. Unknown
 * fields stay opaque. Inbound client methods that this bridge does not
 * implement are answered with an explicit JSON-RPC error instead of being
 * silently accepted.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_INBOUND_FRAME_BYTES = 16 * 1024 * 1024;

export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly method?: string,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

export class AcpConnectionClosedError extends Error {
  constructor(message: string, readonly pendingMethods: readonly string[]) {
    super(message);
    this.name = "AcpConnectionClosedError";
  }
}

export interface AcpAgentInfo {
  readonly name?: string;
  readonly title?: string;
  readonly version?: string;
}

export interface AcpPromptCapabilities {
  readonly image?: boolean;
  readonly audio?: boolean;
  readonly embeddedContext?: boolean;
}

export interface AcpAgentCapabilities {
  readonly loadSession?: boolean;
  readonly promptCapabilities?: AcpPromptCapabilities;
  readonly sessionCapabilities?: Readonly<Record<string, unknown>>;
  readonly mcpCapabilities?: Readonly<Record<string, unknown>>;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentInfo?: AcpAgentInfo;
  readonly agentCapabilities?: AcpAgentCapabilities;
  readonly authMethods?: readonly unknown[];
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface AcpSessionModeState {
  readonly currentModeId: string;
  readonly availableModes: readonly AcpSessionMode[];
}

export interface AcpConfigOptionValue {
  readonly value: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface AcpConfigOption {
  readonly type: "select" | "boolean";
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly description?: string | null;
  readonly currentValue?: unknown;
  readonly options?: readonly AcpConfigOptionValue[];
}

export interface AcpModel {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface AcpModelState {
  readonly currentModelId: string | null;
  readonly availableModels: readonly AcpModel[];
}

export interface AcpNewSessionResult {
  readonly sessionId: string;
  readonly modes?: AcpSessionModeState;
  readonly configOptions?: readonly AcpConfigOption[];
  readonly models?: AcpModelState;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface AcpPromptResult {
  readonly stopReason: string;
}

export interface AcpConnectionOptions {
  readonly dsh?: boolean;
  readonly agy?: boolean;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Inbound client requests. Reject to answer with a JSON-RPC error. */
  readonly onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
  readonly onNotification: (method: string, params: Record<string, unknown>) => void;
  readonly onDiagnostic?: (line: string) => void;
  readonly onExit?: (error: Error) => void;
  /** Optional raw wire trace for acceptance recordings; never persisted by default. */
  readonly onFrame?: (direction: "in" | "out", frame: unknown) => void;
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
  readonly requestTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function parseInitializeResult(value: unknown): AcpInitializeResult {
  if (!isRecord(value) || typeof value.protocolVersion !== "number") {
    throw new Error("ACP initialize result is missing protocolVersion");
  }
  const info = record(value.agentInfo);
  const capabilities = record(value.agentCapabilities);
  const prompt = record(capabilities?.promptCapabilities);
  const meta = record(value._meta);
  const result: AcpInitializeResult = {
    protocolVersion: value.protocolVersion,
    ...(info === undefined ? {} : {
      agentInfo: {
        ...(optionalString(info.name) === undefined ? {} : { name: optionalString(info.name)! }),
        ...(optionalString(info.title) === undefined ? {} : { title: optionalString(info.title)! }),
        ...(optionalString(info.version) === undefined ? {} : { version: optionalString(info.version)! }),
      },
    }),
    ...(capabilities === undefined ? {} : {
      agentCapabilities: {
        ...(capabilities.loadSession === true ? { loadSession: true } : {}),
        ...(prompt === undefined ? {} : {
          promptCapabilities: {
            ...(optionalBoolean(prompt.image) === undefined ? {} : { image: optionalBoolean(prompt.image)! }),
            ...(optionalBoolean(prompt.audio) === undefined ? {} : { audio: optionalBoolean(prompt.audio)! }),
            ...(optionalBoolean(prompt.embeddedContext) === undefined
              ? {}
              : { embeddedContext: optionalBoolean(prompt.embeddedContext)! }),
          },
        }),
        ...(record(capabilities.sessionCapabilities) === undefined
          ? {}
          : { sessionCapabilities: record(capabilities.sessionCapabilities)! }),
        ...(record(capabilities.mcpCapabilities) === undefined
          ? {}
          : { mcpCapabilities: record(capabilities.mcpCapabilities)! }),
        ...(record(capabilities._meta) === undefined ? {} : { _meta: record(capabilities._meta)! }),
      },
    }),
    ...(Array.isArray(value.authMethods) ? { authMethods: value.authMethods } : {}),
    ...(meta === undefined ? {} : { _meta: meta }),
  };
  return result;
}

function parseModelState(value: unknown): AcpModelState | undefined {
  if (!isRecord(value)) return undefined;
  const available = Array.isArray(value.availableModels)
    ? value.availableModels.flatMap((entry: unknown): AcpModel[] => {
      if (!isRecord(entry) || typeof entry.modelId !== "string" || entry.modelId.length === 0) return [];
      return [{
        modelId: entry.modelId,
        name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.modelId,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(isRecord(entry._meta) ? { _meta: entry._meta } : {}),
      }];
    })
    : [];
  return {
    currentModelId: typeof value.currentModelId === "string" ? value.currentModelId : null,
    availableModels: available,
  };
}

export function parseNewSessionResult(value: unknown): AcpNewSessionResult {
  if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error("ACP session/new result is missing sessionId");
  }
  const modes = record(value.modes);
  const modeState = modes === undefined ? undefined : {
    currentModeId: typeof modes.currentModeId === "string" ? modes.currentModeId : "",
    availableModes: Array.isArray(modes.availableModes)
      ? modes.availableModes.flatMap((entry: unknown) => {
          const mode = record(entry);
          return mode !== undefined && typeof mode.id === "string" && typeof mode.name === "string"
            ? [{ id: mode.id, name: mode.name, ...(typeof mode.description === "string" ? { description: mode.description } : {}) }]
            : [];
        })
      : [],
  };
  const configOptions = Array.isArray(value.configOptions)
    ? value.configOptions.flatMap((entry: unknown): AcpConfigOption[] => {
        const option = record(entry);
        if (option === undefined || (option.type !== "select" && option.type !== "boolean")
          || typeof option.id !== "string" || typeof option.name !== "string") return [];
        return [{
          type: option.type,
          id: option.id,
          name: option.name,
          ...(typeof option.category === "string" ? { category: option.category } : {}),
          ...(typeof option.description === "string" ? { description: option.description } : {}),
          ...("currentValue" in option ? { currentValue: option.currentValue } : {}),
          ...(Array.isArray(option.options)
            ? {
                options: option.options.flatMap((choice: unknown): AcpConfigOptionValue[] => {
                  const value = record(choice);
                  return value !== undefined && typeof value.value === "string" && typeof value.name === "string"
                    ? [{
                        value: value.value,
                        name: value.name,
                        ...(typeof value.description === "string" ? { description: value.description } : {}),
                      }]
                    : [];
                }),
              }
            : {}),
        }];
      })
    : undefined;
  return {
    sessionId: value.sessionId,
    ...(modeState === undefined ? {} : { modes: modeState }),
    ...(configOptions === undefined ? {} : { configOptions }),
    ...(parseModelState(value.models) === undefined ? {} : { models: parseModelState(value.models)! }),
    ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
  };
}

export function parsePromptResult(value: unknown): AcpPromptResult {
  if (!isRecord(value) || typeof value.stopReason !== "string") {
    throw new Error("ACP session/prompt result is missing stopReason");
  }
  return { stopReason: value.stopReason };
}

export interface AcpRequestOptions {
  /** `0` disables the timeout (used for session/prompt). */
  readonly timeoutMs?: number;
}

/** A single ACP agent process. The bridge owns its lifetime. */
export class AcpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  dsh: DshChannel | undefined;
  agy: AgyChannel | undefined;
  private overlay: string | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, {
    method: string;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer?: NodeJS.Timeout;
  }>();
  private decoder = new StringDecoder("utf8");
  private carry = "";
  private closing = false;
  private exited: Error | null = null;
  private exitNotified = false;

  constructor(private readonly options: AcpConnectionOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get exitReason(): Error | null {
    return this.exited;
  }

  get writable(): boolean {
    return this.child !== null && !this.closing && this.exited === null && this.child.stdin.writable;
  }

  async spawn(): Promise<void> {
    if (this.child !== null) throw new Error("ACP connection already started");
    const args = [...this.options.args];
    if (this.options.agy) this.agy = await AgyChannel.create(this.options.command, { ...process.env, ...this.options.env }, (method,params) => this.options.onFrame?.("in", { private: true, method, params }));
    const dsh = this.options.dsh && (process.platform === "linux" || process.platform === "darwin");
    if (dsh) {
      this.overlay = await mkdtemp(join(tmpdir(), "opencraft-dsh-"));
      const patch = join(this.overlay, "steering.json");
      await writeFile(patch, JSON.stringify([{ insert: [{ id: "opencraft-acp-steering", name: fileURLToPath(new URL("./dsh-steering.mjs", import.meta.url)) }] }]), { mode: 0o600 });
      args.push("--patch", patch);
    }
    const child = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}), ...this.agy?.env, ...(dsh ? { DSH_ACP_STEERING_FD: "3" } : {}) },
      stdio: dsh ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
    this.child = child as ChildProcessWithoutNullStreams;
    if (dsh && child.stdio[3] instanceof Duplex) {
      this.dsh = new DshChannel(child.stdio[3], (method, params) => {
        this.options.onFrame?.("in", { private: true, method, params });
        this.options.onNotification("opencraft/dsh/" + method, params);
      });
    }
    child.stdout!.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/u)) {
        if (line.length === 0) continue;
        this.options.onDiagnostic?.(line);
      }
    });
    child.once("error", (error) => this.finish(error));
    child.stdin!.on("error", (error) => this.finish(error));
    child.once("exit", (code, signal) => {
      this.finish(new Error(`ACP agent exited (${signal ?? String(code)})`));
    });
  }

  private finish(error: Error): void {
    if (this.exited !== null) return;
    this.exited = error;
    void this.agy?.close().catch(() => {});
    const pendingMethods = [...this.pending.values()].map((entry) => entry.method);
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(new AcpConnectionClosedError(error.message, pendingMethods));
    }
    this.pending.clear();
    if (!this.exitNotified) {
      this.exitNotified = true;
      this.options.onExit?.(error);
    }
  }

  private receive(chunk: Buffer): void {
    this.carry += this.decoder.write(chunk);
    for (;;) {
      const newline = this.carry.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.carry, "utf8") > MAX_INBOUND_FRAME_BYTES) {
          this.options.onDiagnostic?.("ACP frame exceeded the 16 MiB bridge limit; closing the agent");
          this.child?.kill("SIGKILL");
          this.finish(new Error("ACP agent frame too large"));
        }
        return;
      }
      const line = this.carry.slice(0, newline);
      this.carry = this.carry.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        this.options.onDiagnostic?.("ACP agent wrote an invalid JSON frame; closing the agent");
        this.child?.kill("SIGKILL");
        this.finish(new Error("ACP agent wrote invalid JSON"));
        return;
      }
      void this.dispatch(frame).catch((error: unknown) => {
        this.finish(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  private async dispatch(frame: unknown): Promise<void> {
    this.options.onFrame?.("in", frame);
    if (isRecord(frame) && typeof frame.method !== "string" && typeof frame.id === "number" && this.pending.get(frame.id)?.method === "session/prompt") this.agy?.finish();
    if (!isRecord(frame)) {
      this.options.onDiagnostic?.("ACP agent wrote a non-object frame");
      return;
    }
    if (typeof frame.method === "string") {
      const params = record(frame.params) ?? {};
      if (frame.id === undefined) {
        try {
          this.options.onNotification(frame.method, params);
        } catch (error) {
          this.options.onDiagnostic?.(`ACP notification handler failed: ${String(error)}`);
        }
        return;
      }
      try {
        const result = await this.options.onRequest(frame.method, params);
        this.safeSend({ jsonrpc: "2.0", id: frame.id, result: result ?? {} });
      } catch (error) {
        const code = error instanceof AcpRpcError ? error.code : -32603;
        this.safeSend({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code, message: error instanceof Error ? error.message : "ACP client request failed" },
        });
      }
      return;
    }
    const id = typeof frame.id === "number" ? frame.id : typeof frame.id === "string" ? Number(frame.id) : Number.NaN;
    const call = this.pending.get(id);
    if (call === undefined) return;
    this.pending.delete(id);
    if (call.timer !== undefined) clearTimeout(call.timer);
    if (isRecord(frame.error)) {
      const code = typeof frame.error.code === "number" ? frame.error.code : -32603;
      call.reject(new AcpRpcError(code, typeof frame.error.message === "string" ? frame.error.message : "ACP request failed", frame.error.data, call.method));
    } else {
      call.resolve(frame.result);
    }
  }

  private safeSend(value: unknown): void {
    try {
      this.send(value);
    } catch (error) {
      // The agent may exit while a client request is being answered. This is
      // the connection's exit condition, not an unhandled rejection.
      this.finish(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private send(value: unknown): void {
    if (this.child === null || this.closing || !this.child.stdin.writable) {
      throw new AcpConnectionClosedError("ACP agent is not writable", []);
    }
    this.options.onFrame?.("out", value);
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  request(method: string, params: Record<string, unknown>, options: AcpRequestOptions = {}): Promise<unknown> {
    if (this.exited !== null) {
      return Promise.reject(new AcpConnectionClosedError(this.exited.message, [method]));
    }
    if (this.child === null) return Promise.reject(new Error("ACP connection was not started"));
    const id = ++this.nextId;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const entry = { method, resolve, reject, ...(timeoutMs > 0 ? {
        timer: setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP ${method} outcome is unconfirmed after ${timeoutMs}ms`));
        }, timeoutMs),
      } : {}) };
      if (entry.timer !== undefined) entry.timer.unref?.();
      this.pending.set(id, entry);
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(clientName = "opencraft-agent-bridge", clientVersion = "1"): Promise<AcpInitializeResult> {
    const raw = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: clientName, version: clientVersion },
      // Only advertise services this bridge actually implements. The probe
      // connection keeps this empty; a live session advertises its client host.
      clientCapabilities: this.options.clientCapabilities ?? {},
    });
    const parsed = parseInitializeResult(raw);
    if (this.options.agy) return { ...parsed, _meta: { ...parsed._meta, [AGY_PROBE]: this.agy?.ready === true } };
    if (!this.options.dsh) return parsed;
    const deadline = Date.now() + 1500;
    while (this.dsh && !this.dsh.ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    return { ...parsed, _meta: { ...parsed._meta, midTurnSteering: this.dsh?.ready === true } };
  }

  async close(graceMs = 3_000): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.dsh?.close();
    await this.agy?.close();
    if (this.overlay) await rm(this.overlay, { recursive: true, force: true });
    const child = this.child;
    if (child === null) return;
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(new AcpConnectionClosedError("ACP connection closed by the bridge", []));
    }
    this.pending.clear();
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
