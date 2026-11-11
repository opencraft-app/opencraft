#!/usr/bin/env node
/**
 * Standalone Pi provider bridge.
 *
 * stdout is protocol only (bounded JSONL); stderr carries diagnostics. The
 * process is spawned by the independent Agent Bridge Host inside its sandbox.
 * It is not a second AppServer engine and it never spawns a Pi RPC child: the
 * durable owner opened here is the existing `PiDurableSession`, one writer per
 * bridge-owned SQLite file.
 */

import { StringDecoder } from "node:string_decoder";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { BRIDGE_ERROR_CODES, decodeFrame, encodeFrame, isBridgeCommand, isRequest, makeBridgeError, splitLines, type BridgeWireMessage } from "@opencraft/agent-bridge-protocol";
import { BridgeRequestError, PiBridge } from "./bridge.js";
import { DurablePiOwnerFactory } from "./owner.js";

const MAX_FRAME = 1_048_576;
const decoder = new StringDecoder("utf8");
let carry = { carry: "", discarding: false };
const writes = new Set<Promise<void>>();
const pendingCallbacks = new Map<string, { resolve(message: BridgeWireMessage): void; reject(error: Error): void }>();
const bridgeIncarnation = randomUUID();

function diagnostic(message: string): void {
  process.stderr.write(`pi-bridge: ${message}\n`);
}

function write(message: BridgeWireMessage): Promise<void> {
  const data = encodeFrame(message) + "\n";
  if (Buffer.byteLength(data) > MAX_FRAME) return Promise.reject(new Error("Bridge frame exceeds the bounded JSONL limit"));
  const task = new Promise<void>((resolve, reject) => {
    process.stdout.write(data, error => error ? reject(error) : resolve());
  });
  writes.add(task);
  void task.finally(() => writes.delete(task)).catch(() => {});
  return task;
}

async function callback(
  method: "thread/delta" | "thread/identity" | "interaction/request" | "provider/recovery",
  params: unknown,
  id: string,
): Promise<void> {
  const response = new Promise<BridgeWireMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCallbacks.delete(id);
      reject(new Error(`Host did not acknowledge ${method} within 60s`));
    }, 60_000);
    pendingCallbacks.set(id, {
      resolve: message => { clearTimeout(timer); resolve(message); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
  });
  try {
    await write({ jsonrpc: "2.0", id, method, params });
  } catch (error) {
    const waiter = pendingCallbacks.get(id);
    if (waiter) {
      pendingCallbacks.delete(id);
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
    throw error;
  }
  const result = await response;
  if ("error" in result) throw new Error(`Host rejected callback ${method}: ${result.error.message}`);
}

function configuration(): { factory: DurablePiOwnerFactory } {
  const dataDir = process.env.PI_BRIDGE_DATA_DIR;
  if (!dataDir || !isAbsolute(dataDir)) throw new Error("PI_BRIDGE_DATA_DIR must be an absolute private directory");
  const agentDirectory = process.env.PI_BRIDGE_AGENT_DIR ?? dataDir;
  if (!isAbsolute(agentDirectory)) throw new Error("PI_BRIDGE_AGENT_DIR must be absolute when set");
  const modelPolicyPath = process.env.PI_BRIDGE_MODEL_POLICY || undefined;
  return {
    factory: new DurablePiOwnerFactory({ dataDir, agentDirectory, ...(modelPolicyPath === undefined ? {} : { modelPolicyPath }) }),
  };
}

let bridge: PiBridge | undefined;
let closing = false;

async function receive(line: string): Promise<void> {
  const decoded = decodeFrame(line, { maxFrameBytes: MAX_FRAME });
  if (decoded.kind === "error") {
    await write({ jsonrpc: "2.0", id: null, error: decoded.error }).catch(() => {});
    return;
  }
  const message = decoded.message;
  if (isRequest(message)) {
    if (!bridge) {
      await write({ jsonrpc: "2.0", id: message.id, error: makeBridgeError("internal", BRIDGE_ERROR_CODES.internal, "Bridge is not initialized") });
      return;
    }
    try {
      const result = message.method === "initialize"
        ? bridge.initialize(message.params)
        : isBridgeCommand(message.method)
          ? await bridge.command(message.method, message.params)
          : (() => { throw new BridgeRequestError("unsupported", BRIDGE_ERROR_CODES.methodNotFound, `Unsupported bridge method ${message.method}`); })();
      await write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      const typed = error instanceof BridgeRequestError
        ? error.toErrorObject()
        : makeBridgeError("internal", BRIDGE_ERROR_CODES.internal, error instanceof Error ? error.message : String(error));
      diagnostic(`${message.method} failed: ${typed.message}`);
      await write({ jsonrpc: "2.0", id: message.id, error: typed }).catch(() => {});
    }
    return;
  }
  if (!("method" in message) && typeof message.id === "string") {
    const waiter = pendingCallbacks.get(message.id);
    if (waiter) {
      pendingCallbacks.delete(message.id);
      waiter.resolve(message);
    }
  }
}

async function shutdown(code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  const current = bridge;
  bridge = undefined;
  await current?.close().catch(error => diagnostic(`close failed: ${error instanceof Error ? error.message : String(error)}`));
  await Promise.allSettled([...writes]);
  process.exit(code);
}

process.stdin.on("data", chunk => {
  const batch = splitLines(decoder.write(Buffer.from(chunk)), carry, { maxFrameBytes: MAX_FRAME });
  carry = { carry: batch.carry, discarding: batch.discarding };
  for (const error of batch.oversized) void write({ jsonrpc: "2.0", id: null, error }).catch(() => {});
  for (const line of batch.lines) {
    void receive(line).catch(error => diagnostic(error instanceof Error ? error.message : String(error)));
  }
});
process.stdin.on("end", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });
process.on("SIGINT", () => { void shutdown(0); });
process.on("uncaughtException", error => { diagnostic(`uncaught: ${error.stack ?? error.message}`); void shutdown(1); });
process.on("unhandledRejection", error => { diagnostic(`unhandled: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); });

try {
  const { factory } = configuration();
  bridge = new PiBridge({ factory, send: callback });
  diagnostic(`ready incarnation=${bridgeIncarnation} pid=${process.pid}`);
} catch (error) {
  diagnostic(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
