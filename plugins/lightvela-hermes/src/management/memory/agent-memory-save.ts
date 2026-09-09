import type { HermesDebugCommandExecutor as BotRepository } from "../debug-command";
import { isExecCommandSucceeded, truncateExecOutput } from "../debug-command";
import {
  HERMES_MEMORY_COMMAND_TIMEOUT_MS,
  buildHermesMemoryLimitCommand,
  fetchHermesMemorySnapshot,
  type HermesMemoryLimitTarget,
  type HermesMemorySnapshot,
} from "./agent-memory";

export type HermesMemoryLimitSaveResult =
  | { status: "success"; snapshot: HermesMemorySnapshot }
  | { status: "failed"; error: Error }
  | { status: "partial"; error: Error };

interface HermesMemoryOperationScope {
  activeBotId: string | undefined;
  requestedBotId: string;
  latestRequestId: number;
  requestId: number;
}

interface SaveHermesMemoryLimitOptions {
  bots: BotRepository;
  botId: string;
  target: HermesMemoryLimitTarget;
  value: number;
  existingChars: number;
  getGatewayRestartCommand: () => Promise<string>;
}

export function isHermesMemoryOperationCurrent(scope: HermesMemoryOperationScope): boolean {
  return scope.activeBotId === scope.requestedBotId
    && scope.latestRequestId === scope.requestId;
}

export function canStartHermesMemoryLimitSave(
  savingTarget: HermesMemoryLimitTarget | null,
): boolean {
  return savingTarget === null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function commandError(stage: "config" | "restart", output: string, status: string): Error {
  return new Error(`Hermes memory ${stage} command failed: ${truncateExecOutput(output, status)}`);
}

function snapshotLimit(snapshot: HermesMemorySnapshot, target: HermesMemoryLimitTarget): number {
  return target === "memory" ? snapshot.memoryCharLimit : snapshot.userCharLimit;
}

export async function saveHermesMemoryLimit(
  options: SaveHermesMemoryLimitOptions,
): Promise<HermesMemoryLimitSaveResult> {
  const { bots, botId, target, value, existingChars, getGatewayRestartCommand } = options;
  let configSaved = false;

  try {
    const configResult = await bots.execDebugCommand(
      botId,
      buildHermesMemoryLimitCommand(target, value, existingChars),
      { timeoutMs: HERMES_MEMORY_COMMAND_TIMEOUT_MS },
    );
    if (!isExecCommandSucceeded(configResult)) {
      throw commandError("config", configResult.output, configResult.status);
    }
    configSaved = true;

    const restartCommand = await getGatewayRestartCommand();
    const restartResult = await bots.execDebugCommand(
      botId,
      restartCommand,
      { timeoutMs: HERMES_MEMORY_COMMAND_TIMEOUT_MS },
    );
    if (!isExecCommandSucceeded(restartResult)) {
      throw commandError("restart", restartResult.output, restartResult.status);
    }

    const snapshot = await fetchHermesMemorySnapshot(bots, botId);
    if (snapshotLimit(snapshot, target) !== value) {
      throw new Error("Hermes memory reread limit did not match the saved value");
    }

    return { status: "success", snapshot };
  } catch (error) {
    return {
      status: configSaved ? "partial" : "failed",
      error: toError(error),
    };
  }
}
