import { Service, type Context } from "@deepseek-ai/cordis";
import { errorMessage } from "../types/domain.ts";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type {
  TransparentBackendPumpHandlers,
  TransparentBackendPumpPort,
  TransparentBackendState,
} from "../types/transparent-backend.ts";

function parseProtocolLine(line: string): JsonRpcResponse | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRpcResponse;
}

/**
 * Pumps JSONL frames from a Codex Runtime without owning Thread semantics.
 *
 * Process I/O, protocol parsing, timeout ticks and process-exit detection are
 * runtime concerns. The caller remains responsible for interpreting AppServer
 * messages and converging failed executions.
 */
export class TransparentBackendPumpService extends Service
  implements TransparentBackendPumpPort {
  static readonly inject = ["codexRuntimeAdapter"];

  constructor(ctx: Context) {
    super(ctx, "transparentBackendPump");
  }

  poll(state: TransparentBackendState, handlers: TransparentBackendPumpHandlers): void {
    this.ctx.codexRuntimeAdapter.tick();
    let drained;
    try {
      drained = state.filesystem.drain(state.processId);
    } catch (error) {
      handlers.failed(errorMessage(error));
      return;
    }
    if (drained.stderrLines?.length) state.stderr.push(...drained.stderrLines.slice(-32));
    for (const line of drained.stdoutLines ?? []) {
      const message = parseProtocolLine(line);
      if (message !== null) handlers.message(message);
    }
    if (drained.exited) {
      handlers.failed(drained.error || `local Codex exited with ${String(drained.exitCode)}`);
    }
  }
}
