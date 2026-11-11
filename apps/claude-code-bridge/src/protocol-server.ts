import { StringDecoder } from "node:string_decoder";
import {
  assertMethodAllowed,
  bridgeFailure,
  decodeFrame,
  encodeFrame,
  isBridgeCommand,
  isFailure,
  isRequest,
  isSuccess,
  refuseUndeclaredMethod,
  splitLines,
  type BridgeCommand,
  type BridgeFailure,
  type BridgeRequest,
  type BridgeWireMessage,
} from "@opencraft/agent-bridge-protocol";
import { ClaudeBridge } from "./bridge.js";
import { BridgeCommandError } from "./errors.js";
import { CLAUDE_BRIDGE_DECLARATION } from "./declaration.js";
import type { NativeFactory } from "./types.js";

export interface BridgeServerOptions {
  readonly input: AsyncIterable<string | Buffer>;
  readonly write: (data: string) => void | Promise<void>;
  readonly factory: NativeFactory;
  readonly diagnostics?: (message: string) => void;
  readonly callbackTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
}

interface CallbackWaiter {
  readonly resolve: (message: BridgeWireMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Bounded JSONL endpoint for the P1b Host. Requests are answered only after
 * initialize; callbacks are bridge-initiated requests so the Host's durable
 * commit acknowledgement gates the next delta. Diagnostics never use stdout.
 */
export class BridgeProtocolServer {
  readonly bridge: ClaudeBridge;
  private readonly decoder = new StringDecoder("utf8");
  private lines = { carry: "", discarding: false };
  private readonly pending = new Map<string, CallbackWaiter>();
  private sequence = 0;
  private initialized = false;
  private closed = false;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly pendingRequests = new Set<Promise<void>>();

  constructor(private readonly options: BridgeServerOptions) {
    this.bridge = new ClaudeBridge({
      factory: options.factory,
      declaration: CLAUDE_BRIDGE_DECLARATION,
      callbacks: { notify: (method, params) => this.notify(method, params) },
      ...(options.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: options.initializeTimeoutMs } : {}),
    });
  }

  /**
   * Feed one chunk from the Host. Request lines are serialized; response
   * lines are settled immediately so a callback acknowledgement can be read
   * while the requesting command is still awaiting it.
   */
  async feed(chunk: string | Buffer): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const line of this.decode(chunk)) {
      const operation = this.dispatch(line);
      if (operation !== undefined) pending.push(operation);
    }
    for (const operation of pending) await operation;
  }

  async run(): Promise<void> {
    for await (const chunk of this.options.input) {
      for (const line of this.decode(chunk)) this.dispatch(line);
    }
    await Promise.allSettled([...this.pendingRequests]);
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Bridge transport closed"));
    }
    this.pending.clear();
    await this.bridge.close();
    await this.writeTail.catch(() => {});
  }

  /** Send one callback request and wait for the Host's durable acknowledgement. */
  async notify(method: "thread/delta" | "thread/identity" | "provider/recovery", params: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error("Bridge transport is closed");
    const id = `bridge:cb:${++this.sequence}`;
    const response = new Promise<BridgeWireMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Host did not acknowledge ${method} within the callback timeout`));
      }, this.options.callbackTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    void response.catch(() => {});
    if (process.env.CLAUDE_BRIDGE_DEBUG) this.options.diagnostics?.(`callback ${id} ${method} sending`);
    try {
      await this.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.rejectPending(id, error as Error);
      throw error;
    }
    const message = await response;
    if (process.env.CLAUDE_BRIDGE_DEBUG) this.options.diagnostics?.(`callback ${id} ${method} acknowledged`);
    if (isFailure(message)) throw new Error(message.error.message);
  }

  private decode(chunk: string | Buffer): readonly string[] {
    const batch = splitLines(this.decoder.write(Buffer.from(chunk)), this.lines);
    this.lines = batch;
    if (batch.oversized.length > 0) {
      void this.send(bridgeFailure(null, {
        kind: "frame-too-large",
        code: -32007,
        message: "Bridge frame exceeds the 1 MiB limit",
      })).catch(() => {});
    }
    return batch.lines;
  }

  /** Dispatch one line; a request returns a serialized completion promise. */
  private dispatch(line: string): Promise<void> | undefined {
    const decoded = decodeFrame(line);
    if (decoded.kind === "error") {
      void this.send(bridgeFailure(null, decoded.error)).catch(() => {});
      return undefined;
    }
    const message = decoded.message;
    if (isRequest(message)) {
      // The bridge owns per-route serialization; unrelated Threads and probes
      // must not head-of-line block each other on one process-wide chain.
      const operation = this.handleRequest(message);
      this.pendingRequests.add(operation);
      void operation.then(
        () => { this.pendingRequests.delete(operation); },
        () => { this.pendingRequests.delete(operation); },
      );
      return operation;
    }
    if (isSuccess(message) || isFailure(message)) {
      const waiter = this.pending.get(String(message.id));
      if (waiter === undefined) return undefined;
      clearTimeout(waiter.timer);
      this.pending.delete(String(message.id));
      waiter.resolve(message);
    }
    return undefined;
  }

  private async handleRequest(request: BridgeRequest): Promise<void> {
    if (request.method === "initialize") {
      try {
        const result = this.bridge.initialize(request.params);
        this.initialized = true;
        await this.send({ jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        await this.send(this.failure(request.id, error));
      }
      return;
    }
    if (!this.initialized) {
      await this.send(this.failure(request.id, new BridgeCommandError("unsupported", -32001, "Bridge is not initialized")));
      return;
    }
    if (!isBridgeCommand(request.method)) {
      await this.send(this.failure(request.id, new BridgeCommandError("unsupported", -32601, `Unknown bridge method ${request.method}`)));
      return;
    }
    const capabilities = this.bridge.effectiveCapabilities;
    if (capabilities === undefined) {
      await this.send(this.failure(request.id, new BridgeCommandError("unsupported", -32001, "Bridge capabilities are unavailable")));
      return;
    }
    const admission = assertMethodAllowed(capabilities, request.method as BridgeCommand);
    if (!admission.ok) {
      await this.send(refuseUndeclaredMethod(request.id, admission));
      return;
    }
    try {
      const result = await this.bridge.command(request.method, request.params);
      await this.send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      await this.send(this.failure(request.id, error));
    }
  }

  private failure(id: string, error: unknown): BridgeFailure {
    if (error instanceof BridgeCommandError) {
      return bridgeFailure(id, {
        kind: error.kind,
        code: error.code,
        message: error.message,
        ...(error.data !== undefined ? { data: error.data } : {}),
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    this.options.diagnostics?.(`bridge internal error: ${message}`);
    return bridgeFailure(id, { kind: "internal", code: -32603, message });
  }

  private rejectPending(id: string, error: Error): void {
    const waiter = this.pending.get(id);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.pending.delete(id);
    waiter.reject(error);
  }

  private send(message: BridgeWireMessage | BridgeFailure): Promise<void> {
    const data = `${encodeFrame(message)}\n`;
    this.writeTail = this.writeTail.then(() => this.options.write(data));
    return this.writeTail;
  }
}
