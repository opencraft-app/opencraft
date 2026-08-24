import type { BotRepository } from "@/repositories/types";
import { isExecCommandSucceeded, truncateExecOutput } from "@/pages/marketing/agent-reset-config";
import {
  HERMES_COMMON_SETTINGS_TIMEOUT_MS,
  buildHermesCommonSettingUnsetCommand,
  fetchHermesCommonSettingsSnapshot,
  getHermesCommonSettingKeysForGroup,
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

function commandError(stage: "unset" | "restart", output: string, status: string): Error {
  return new Error(`Hermes common settings ${stage} command failed: ${truncateExecOutput(output, status)}`);
}

export async function resetHermesCommonSettingsGroup(
  options: ResetHermesCommonSettingsGroupOptions,
): Promise<HermesCommonSettingsResetResult> {
  const { bots, botId, group, snapshot, getGatewayRestartCommand } = options;
  const targetKeys = getHermesCommonSettingKeysForGroup(group)
    .filter((key) => !snapshot.defaultedKeys.includes(key));

  if (targetKeys.length === 0) {
    return { status: "success", snapshot };
  }

  const succeededKeys: HermesCommonSettingKey[] = [];
  const unsetErrors: Error[] = [];

  for (const key of targetKeys) {
    try {
      const result = await bots.execDebugCommand(
        botId,
        buildHermesCommonSettingUnsetCommand(key),
        { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
      );
      if (isExecCommandSucceeded(result)) {
        succeededKeys.push(key);
      } else {
        unsetErrors.push(commandError("unset", result.output, result.status));
      }
    } catch (error) {
      unsetErrors.push(toError(error));
    }
  }

  if (succeededKeys.length === 0) {
    return { status: "failed", error: unsetErrors[0] ?? new Error("No settings were restored") };
  }

  try {
    const restartCommand = await getGatewayRestartCommand();
    const restartResult = await bots.execDebugCommand(
      botId,
      restartCommand,
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    if (!isExecCommandSucceeded(restartResult)) {
      return { status: "partial", error: commandError("restart", restartResult.output, restartResult.status) };
    }

    const verifiedSnapshot = await fetchHermesCommonSettingsSnapshot(bots, botId);
    const firstUnsetError = unsetErrors[0];
    if (firstUnsetError) {
      return { status: "partial", error: firstUnsetError, snapshot: verifiedSnapshot };
    }
    if (!targetKeys.every((key) => verifiedSnapshot.defaultedKeys.includes(key))) {
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
