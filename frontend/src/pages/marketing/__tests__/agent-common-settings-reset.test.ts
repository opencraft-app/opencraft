import { describe, expect, it, vi } from "vitest";
import type { BotRepository } from "@/repositories/types";

import {
  HERMES_COMMON_SETTINGS_JSON_END,
  HERMES_COMMON_SETTINGS_JSON_START,
  HERMES_COMMON_SETTINGS_TIMEOUT_MS,
  type HermesCommonSettingsSnapshot,
} from "../agent-common-settings";
import { resetHermesCommonSettingsGroup } from "../agent-common-settings-reset";

const snapshot = (
  defaultedKeys: HermesCommonSettingsSnapshot["defaultedKeys"] = [],
  unsupportedKeys: HermesCommonSettingsSnapshot["unsupportedKeys"] = [],
  values: Partial<HermesCommonSettingsSnapshot["values"]> = {},
): HermesCommonSettingsSnapshot => ({
  values: {
    approvalMode: "off",
    destructiveSlashConfirm: false,
    persistentMemory: true,
    userProfile: true,
    autoCompression: true,
    compressionThreshold: 0.5,
    compressionTarget: 0.2,
    protectedRecentMessages: 20,
    ...values,
  },
  defaultedKeys,
  unsupportedKeys,
});

const snapshotOutput = (
  defaultedKeys: HermesCommonSettingsSnapshot["defaultedKeys"],
  unsupportedKeys: HermesCommonSettingsSnapshot["unsupportedKeys"] = [],
  values: Partial<HermesCommonSettingsSnapshot["values"]> = {},
) => [
  HERMES_COMMON_SETTINGS_JSON_START,
  JSON.stringify(snapshot(defaultedKeys, unsupportedKeys, values)),
  HERMES_COMMON_SETTINGS_JSON_END,
].join("\n");

const succeeded = (output = "") => ({ status: "Succeeded", exitCode: 0, output });
const failed = (output: string) => ({ status: "Failed", exitCode: 1, output });
const botsWith = (execDebugCommand: ReturnType<typeof vi.fn>) => (
  { execDebugCommand } as Pick<BotRepository, "execDebugCommand"> as BotRepository
);

describe("resetHermesCommonSettingsGroup", () => {
  it("restores Security to the LightVela preset without restarting Gateway", async () => {
    const verified = snapshot();
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded([
        HERMES_COMMON_SETTINGS_JSON_START,
        JSON.stringify(verified),
        HERMES_COMMON_SETTINGS_JSON_END,
      ].join("\n")));
    const getGatewayRestartCommand = vi.fn(async () => "hermes gateway restart");

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "security",
      snapshot: snapshot([], [], {
        approvalMode: "smart",
        destructiveSlashConfirm: true,
      }),
      getGatewayRestartCommand,
    });

    expect(result).toMatchObject({
      status: "success",
      snapshot: { values: { approvalMode: "off", destructiveSlashConfirm: false } },
    });
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      1,
      "bot-a",
      "hermes config set approvals.mode off",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      2,
      "bot-a",
      "hermes config set approvals.destructive_slash_confirm false",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    expect(execDebugCommand).toHaveBeenCalledTimes(3);
    expect(getGatewayRestartCommand).not.toHaveBeenCalled();
  });

  it("writes only the Security setting that differs from the LightVela preset", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded(snapshotOutput([])));

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "security",
      snapshot: snapshot([], [], { destructiveSlashConfirm: true }),
      getGatewayRestartCommand: vi.fn(async () => "restart"),
    });

    expect(result).toMatchObject({ status: "success" });
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      1,
      "bot-a",
      "hermes config set approvals.destructive_slash_confirm false",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    expect(execDebugCommand).toHaveBeenCalledTimes(2);
  });

  it("returns partial when Security reread does not match the LightVela preset", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded(snapshotOutput([], [], {
        destructiveSlashConfirm: true,
      })));

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "security",
      snapshot: snapshot([], [], {
        approvalMode: "manual",
        destructiveSlashConfirm: true,
      }),
      getGatewayRestartCommand: vi.fn(async () => "restart"),
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { message: expect.stringContaining("did not return to defaults") },
      snapshot: { values: { approvalMode: "off", destructiveSlashConfirm: true } },
    });
  });

  it("resets only the memory group, restarts once, and verifies defaults", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded(snapshotOutput(["persistentMemory", "userProfile"])));

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "memory",
      snapshot: snapshot(),
      getGatewayRestartCommand: async () => "hermes gateway restart",
    });

    expect(result).toMatchObject({ status: "success" });
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      1,
      "bot-a",
      "hermes config unset memory.memory_enabled",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      2,
      "bot-a",
      "hermes config unset memory.user_profile_enabled",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      3,
      "bot-a",
      "hermes gateway restart",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    const unsetCommands = execDebugCommand.mock.calls
      .map(([, command]) => String(command))
      .filter((command) => command.startsWith("hermes config unset"));
    expect(unsetCommands.some((command) => command.includes("compression."))).toBe(false);
    expect(execDebugCommand).toHaveBeenCalledTimes(4);
  });

  it("skips unsupported settings while resetting the rest of a group", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded(snapshotOutput(["persistentMemory"], ["userProfile"])));
    const getGatewayRestartCommand = vi.fn(async () => "hermes gateway restart");

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "memory",
      snapshot: snapshot([], ["userProfile"]),
      getGatewayRestartCommand,
    });

    expect(result).toMatchObject({ status: "success" });
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      1,
      "bot-a",
      "hermes config unset memory.memory_enabled",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    expect(execDebugCommand.mock.calls.some(([, command]) => (
      String(command) === "hermes config unset memory.user_profile_enabled"
    ))).toBe(false);
    expect(getGatewayRestartCommand).toHaveBeenCalledTimes(1);
    expect(execDebugCommand).toHaveBeenCalledTimes(3);
  });

  it("resets only the context group", async () => {
    const contextKeys: HermesCommonSettingsSnapshot["defaultedKeys"] = [
      "autoCompression",
      "compressionThreshold",
      "compressionTarget",
      "protectedRecentMessages",
    ];
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded(snapshotOutput(contextKeys)));

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "context",
      snapshot: snapshot(),
      getGatewayRestartCommand: async () => "hermes gateway restart",
    });

    expect(result).toMatchObject({ status: "success" });
    expect(execDebugCommand.mock.calls.slice(0, 4).map(([, command]) => command)).toEqual([
      "hermes config unset compression.enabled",
      "hermes config unset compression.threshold",
      "hermes config unset compression.target_ratio",
      "hermes config unset compression.protect_last_n",
    ]);
    const unsetCommands = execDebugCommand.mock.calls
      .map(([, command]) => String(command))
      .filter((command) => command.startsWith("hermes config unset"));
    expect(unsetCommands.some((command) => command.includes("memory."))).toBe(false);
    expect(execDebugCommand).toHaveBeenCalledTimes(6);
  });

  it("returns the supplied snapshot without commands when the group already uses defaults", async () => {
    const execDebugCommand = vi.fn();
    const current = snapshot(["persistentMemory", "userProfile"]);

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "memory",
      snapshot: current,
      getGatewayRestartCommand: vi.fn(async () => "restart"),
    });

    expect(result).toEqual({ status: "success", snapshot: current });
    expect(execDebugCommand).not.toHaveBeenCalled();
  });

  it("returns failed without restarting when every unset fails", async () => {
    const getGatewayRestartCommand = vi.fn(async () => "restart");
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(failed("memory unset failed"))
      .mockResolvedValueOnce(failed("profile unset failed"));

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "memory",
      snapshot: snapshot(),
      getGatewayRestartCommand,
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("memory unset failed") },
    });
    expect(getGatewayRestartCommand).not.toHaveBeenCalled();
    expect(execDebugCommand).toHaveBeenCalledTimes(2);
  });

  it("returns partial after mixed unset results and exposes the verified snapshot", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(failed("profile unset failed"))
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded(snapshotOutput(["persistentMemory"])));

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "memory",
      snapshot: snapshot(),
      getGatewayRestartCommand: async () => "restart",
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { message: expect.stringContaining("profile unset failed") },
      snapshot: { defaultedKeys: ["persistentMemory"] },
    });
    expect(execDebugCommand).toHaveBeenCalledTimes(4);
  });

  it("returns partial when restart fails or reread does not verify every target", async () => {
    const restartExec = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(failed("restart failed"));

    await expect(resetHermesCommonSettingsGroup({
      bots: botsWith(restartExec),
      botId: "bot-a",
      group: "memory",
      snapshot: snapshot(),
      getGatewayRestartCommand: async () => "restart",
    })).resolves.toMatchObject({
      status: "partial",
      error: { message: expect.stringContaining("restart failed") },
    });

    const staleExec = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded(snapshotOutput(["persistentMemory"])));

    await expect(resetHermesCommonSettingsGroup({
      bots: botsWith(staleExec),
      botId: "bot-a",
      group: "memory",
      snapshot: snapshot(),
      getGatewayRestartCommand: async () => "restart",
    })).resolves.toMatchObject({
      status: "partial",
      error: { message: expect.stringContaining("did not return to defaults") },
    });
  });
});
