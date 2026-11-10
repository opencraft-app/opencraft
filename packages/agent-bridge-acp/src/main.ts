/**
 * Executable entry point for the generic ACP bridge.
 *
 * stdout carries only the P1a JSONL bridge protocol. Diagnostics go to stderr.
 * The Host owns the process; SIGTERM/SIGINT close native ACP sessions before
 * the bridge exits.
 */

import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { createWriteStream } from "node:fs";
import {
  BRIDGE_ERROR_CODES,
  decodeFrame,
  splitLines,
  type BridgeErrorKind,
  type BridgeRequest,
} from "@opencraft/agent-bridge-protocol";
import { AcpBridge, BridgeCommandError, type CallbackMethod } from "./bridge";
import { profileFromEnv } from "./profile";

export interface BridgeStdioOptions {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
}

function errorKind(error: unknown): { kind: BridgeErrorKind; code: number; message: string } {
  if (error instanceof BridgeCommandError) {
    return { kind: error.kind, code: error.code, message: error.message };
  }
  return {
    kind: "internal",
    code: BRIDGE_ERROR_CODES.internal,
    message: error instanceof Error ? error.message : "bridge command failed",
  };
}

export async function runBridgeStdio(options: BridgeStdioOptions): Promise<void> {
  const env = options.env ?? process.env;
  const write = (value: unknown): void => {
    options.stdout.write(JSON.stringify(value) + "\n");
  };
  const diagnostic = (line: string): void => {
    options.stderr.write(`[agent-bridge-acp] ${line}\n`);
  };

  let sequence = 0;
  const pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

  const requestCallback = (method: CallbackMethod, params: Record<string, unknown>): Promise<unknown> => {
    const id = `callback:${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Host did not acknowledge ${method} within 30s`));
      }, 30_000);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  };

  const tracePath = env.AGENT_BRIDGE_ACP_TRACE;
  const trace = typeof tracePath === "string" && tracePath.length > 0
    ? createWriteStream(tracePath, { flags: "a", mode: 0o600 })
    : null;
  trace?.on("error", (error) => diagnostic(`wire trace unavailable: ${error.message}`));

  let bridge: AcpBridge;
  try {
    bridge = new AcpBridge({
      profile: profileFromEnv(env),
      requestCallback,
      onDiagnostic: diagnostic,
      ...(trace === null ? {} : {
        onFrame: (direction: "in" | "out", frame: unknown) => {
          try {
            trace.write(JSON.stringify({ direction, frame }) + "\n");
          } catch {
            // A trace is diagnostic; losing it must not stop execution.
          }
        },
      }),
    });
  } catch (error) {
    diagnostic(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const decoder = new StringDecoder("utf8");
  let lines = { carry: "", discarding: false };
  let closing = false;

  const handleLine = async (line: string): Promise<void> => {
    const decoded = decodeFrame(line);
    if (decoded.kind === "error") {
      write({ jsonrpc: "2.0", id: null, error: decoded.error });
      return;
    }
    const message = decoded.message;
    if ("method" in message) {
      if (!("id" in message)) {
        // The Host has no notification commands in this protocol version.
        diagnostic(`ignored Host notification ${message.method}`);
        return;
      }
      const request = message as BridgeRequest;
      try {
        const result = await bridge.handle(request.method, request.params);
        write({ jsonrpc: "2.0", id: request.id, result: result ?? {} });
      } catch (error) {
        const mapped = errorKind(error);
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { kind: mapped.kind, code: mapped.code, message: mapped.message },
        });
      }
      return;
    }
    if (!("result" in message) && !("error" in message)) return;
    const waiter = pending.get(String(message.id));
    if (waiter === undefined) return;
    pending.delete(String(message.id));
    clearTimeout(waiter.timer);
    if ("error" in message && message.error !== undefined) {
      waiter.reject(new Error(`Host rejected callback: ${message.error.message}`));
    } else {
      waiter.resolve("result" in message ? message.result : undefined);
    }
  };

  options.stdin.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    const batch = splitLines(text, lines);
    lines = { carry: batch.carry, discarding: batch.discarding };
    for (const oversized of batch.oversized) {
      diagnostic(oversized.message);
    }
    for (const line of batch.lines) {
      void handleLine(line).catch((error) => diagnostic(String(error)));
    }
  });

  const close = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("bridge is closing"));
    }
    pending.clear();
    await bridge.close().catch((error) => diagnostic(String(error)));
    await new Promise<void>((resolve) => trace === null ? resolve() : trace.end(resolve));
    process.exitCode = code;
  };

  await new Promise<void>((resolve) => {
    const onEnd = (): void => resolve();
    options.stdin.once("end", onEnd);
    options.stdin.once("close", onEnd);
    const stop = (): void => resolve();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  await close(0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBridgeStdio({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  // stdin keeps the event loop alive even after the Host closed the stream or
  // signalled shutdown; the bridge has no other work by this point.
  process.exit(process.exitCode ?? 0);
}
