import type { BotRepository } from "@/repositories/types";
import { isExecCommandSucceeded, truncateExecOutput } from "@/pages/marketing/agent-reset-config";
import {
  HERMES_COMMON_SETTINGS_TIMEOUT_MS,
  buildHermesCommonSettingCommand,
  buildHermesCommonSettingUnsetCommand,
  fetchHermesCommonSettingsSnapshot,
  getHermesCommonSettingKeysForGroup,
  getHermesCommonSettingResetValue,
  isHermesCommonSettingAtResetTarget,
  requiresHermesCommonSettingGatewayRestart,
  type HermesCommonSettingGroup,
  type HermesCommonSettingKey,
  type HermesCommonSettingsSnapshot,
} from "@/pages/marketing/agent-common-settings";

export type HermesCommonSettingsResetResult =
  | { status: "success"; snapshot: HermesCommonSettingsSnapshot }
  | { status: "failed"; error: Error }
  | { status: "partial"; error: Error; snapshot?: HermesCommonSettingsSnapshot };

export interface ResetHermesCommonSettingsGroupOptions {
  bots: BotRepository;
  botId: string;
  group: HermesCommonSettingGroup;
  snapshot: HermesCommonSettingsSnapshot;
  getGatewayRestartCommand: () => Promise<string>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function commandError(stage: "set" | "unset" | "restart", output: string, status: string): Error {
  return new Error(`Hermes common settings ${stage} command failed: ${truncateExecOutput(output, status)}`);
}

export async function resetHermesCommonSettingsGroup(
  options: ResetHermesCommonSettingsGroupOptions,
): Promise<HermesCommonSettingsResetResult> {
  const { bots, botId, group, snapshot, getGatewayRestartCommand } = options;
  const targetKeys = getHermesCommonSettingKeysForGroup(group)
    .filter((key) => !isHermesCommonSettingAtResetTarget(key, snapshot));

  if (targetKeys.length === 0) {
    return { status: "success", snapshot };
  }

  const succeededKeys: HermesCommonSettingKey[] = [];
  const configErrors: Error[] = [];

  for (const key of targetKeys) {
    try {
      const resetValue = getHermesCommonSettingResetValue(key);
      const stage = resetValue === undefined ? "unset" : "set";
      const command = resetValue === undefined
        ? buildHermesCommonSettingUnsetCommand(key)
        : buildHermesCommonSettingCommand(key, resetValue);
      const result = await bots.execDebugCommand(
        botId,
        command,
        { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
      );
      if (isExecCommandSucceeded(result)) {
        succeededKeys.push(key);
      } else {
        configErrors.push(commandError(stage, result.output, result.status));
      }
    } catch (error) {
      configErrors.push(toError(error));
    }
  }

  if (succeededKeys.length === 0) {
    return { status: "failed", error: configErrors[0] ?? new Error("No settings were restored") };
  }

  try {
    if (succeededKeys.some(requiresHermesCommonSettingGatewayRestart)) {
      const restartCommand = await getGatewayRestartCommand();
      const restartResult = await bots.execDebugCommand(
        botId,
        restartCommand,
        { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
      );
      if (!isExecCommandSucceeded(restartResult)) {
        return { status: "partial", error: commandError("restart", restartResult.output, restartResult.status) };
      }
    }

    const verifiedSnapshot = await fetchHermesCommonSettingsSnapshot(bots, botId);
    const firstConfigError = configErrors[0];
    if (firstConfigError) {
      return { status: "partial", error: firstConfigError, snapshot: verifiedSnapshot };
    }
    if (!targetKeys.every((key) => isHermesCommonSettingAtResetTarget(key, verifiedSnapshot))) {
      return {
        status: "partial",
        error: new Error("Hermes common settings did not return to defaults"),
        snapshot: verifiedSnapshot,
      };
    }
    return { status: "success", snapshot: verifiedSnapshot };
  } catch (error) {
    return { status: "partial", error: toError(error) };
  }
}
