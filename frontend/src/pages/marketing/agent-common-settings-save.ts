import type { BotRepository } from "@/repositories/types";
import { isExecCommandSucceeded, truncateExecOutput } from "@/pages/marketing/agent-reset-config";
import {
  HERMES_COMMON_SETTINGS_TIMEOUT_MS,
  buildHermesCommonSettingCommand,
  fetchHermesCommonSettingsSnapshot,
  requiresHermesCommonSettingGatewayRestart,
  type HermesCommonSettingKey,
  type HermesCommonSettingValue,
  type HermesCommonSettingsSnapshot,
} from "@/pages/marketing/agent-common-settings";

export type HermesCommonSettingSaveResult =
  | { status: "success"; snapshot: HermesCommonSettingsSnapshot }
  | { status: "failed"; error: Error }
  | { status: "partial"; error: Error };

export interface SaveHermesCommonSettingOptions {
  bots: BotRepository;
  botId: string;
  key: HermesCommonSettingKey;
  value: HermesCommonSettingValue;
  getGatewayRestartCommand: () => Promise<string>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function commandError(stage: "config" | "restart", output: string, status: string): Error {
  return new Error(`Hermes common settings ${stage} command failed: ${truncateExecOutput(output, status)}`);
}

export async function saveHermesCommonSetting(
  options: SaveHermesCommonSettingOptions,
): Promise<HermesCommonSettingSaveResult> {
  const { bots, botId, key, value, getGatewayRestartCommand } = options;
  let configSaved = false;

  try {
    const configResult = await bots.execDebugCommand(
      botId,
      buildHermesCommonSettingCommand(key, value),
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    if (!isExecCommandSucceeded(configResult)) {
      throw commandError("config", configResult.output, configResult.status);
    }
    configSaved = true;

    if (requiresHermesCommonSettingGatewayRestart(key)) {
      const restartCommand = await getGatewayRestartCommand();
      const restartResult = await bots.execDebugCommand(
        botId,
        restartCommand,
        { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
      );
      if (!isExecCommandSucceeded(restartResult)) {
        throw commandError("restart", restartResult.output, restartResult.status);
      }
    }

    const snapshot = await fetchHermesCommonSettingsSnapshot(bots, botId);
    if (!Object.is(snapshot.values[key], value)) {
      throw new Error("Hermes common settings reread value did not match the saved value");
    }
    return { status: "success", snapshot };
  } catch (error) {
    return {
      status: configSaved ? "partial" : "failed",
      error: toError(error),
    };
  }
}
