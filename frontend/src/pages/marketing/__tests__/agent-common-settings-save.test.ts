import { describe, expect, it, vi } from "vitest";
import type { BotRepository } from "@/repositories/types";

import {
  HERMES_COMMON_SETTINGS_JSON_END,
  HERMES_COMMON_SETTINGS_JSON_START,
  HERMES_COMMON_SETTINGS_TIMEOUT_MS,
  type HermesCommonSettingsSnapshot,
} from "../agent-common-settings";
import { saveHermesCommonSetting } from "../agent-common-settings-save";

const snapshot = (threshold = 0.65): HermesCommonSettingsSnapshot => ({
  values: {
    approvalMode: "off",
    persistentMemory: true,
    userProfile: true,
    autoCompression: true,
    compressionThreshold: threshold,
    compressionTarget: 0.2,
    protectedRecentMessages: 20,
  },
  defaultedKeys: [],
  unsupportedKeys: [],
});

const snapshotOutput = (threshold = 0.65) => [
  HERMES_COMMON_SETTINGS_JSON_START,
  JSON.stringify(snapshot(threshold)),
  HERMES_COMMON_SETTINGS_JSON_END,
].join("\n");
const succeeded = (output = "") => ({ status: "Succeeded", exitCode: 0, output });
const failed = (output: string) => ({ status: "Failed", exitCode: 1, output });

describe("saveHermesCommonSetting", () => {
  it("writes and verifies approval mode without restarting Gateway", async () => {
    const approvalSnapshot: HermesCommonSettingsSnapshot = {
      ...snapshot(),
      values: { ...snapshot().values, approvalMode: "smart" },
    };
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded([
        HERMES_COMMON_SETTINGS_JSON_START,
        JSON.stringify(approvalSnapshot),
        HERMES_COMMON_SETTINGS_JSON_END,
      ].join("\n")));
    const getGatewayRestartCommand = vi.fn(async () => "hermes gateway restart");

    const result = await saveHermesCommonSetting({
      bots: { execDebugCommand } as Pick<BotRepository, "execDebugCommand"> as BotRepository,
      botId: "bot-a",
      key: "approvalMode",
      value: "smart",
      getGatewayRestartCommand,
    });

    expect(result).toMatchObject({ status: "success", snapshot: { values: { approvalMode: "smart" } } });
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      1,
      "bot-a",
      "hermes config set approvals.mode smart",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    expect(execDebugCommand).toHaveBeenCalledTimes(2);
    expect(getGatewayRestartCommand).not.toHaveBeenCalled();
  });

  it("writes config, restarts Gateway, and rereads before reporting success", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded(snapshotOutput()));
    const bots = { execDebugCommand } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    const result = await saveHermesCommonSetting({
      bots,
      botId: "bot-a",
      key: "compressionThreshold",
      value: 0.65,
      getGatewayRestartCommand: async () => "hermes gateway restart",
    });

    expect(result).toMatchObject({ status: "success", snapshot: { values: { compressionThreshold: 0.65 } } });
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      1,
      "bot-a",
      "hermes config set compression.threshold 0.65",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      2,
      "bot-a",
      "hermes gateway restart",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
  });

  it("returns failed when config was not written", async () => {
    const bots = {
      execDebugCommand: vi.fn().mockResolvedValue(failed("permission denied")),
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(saveHermesCommonSetting({
      bots,
      botId: "bot-a",
      key: "persistentMemory",
      value: false,
      getGatewayRestartCommand: async () => "restart",
    })).resolves.toMatchObject({ status: "failed", error: { message: expect.stringContaining("permission denied") } });
  });

  it("returns partial when restart fails or reread does not match", async () => {
    const restartBots = {
      execDebugCommand: vi.fn()
        .mockResolvedValueOnce(succeeded())
        .mockResolvedValueOnce(failed("restart failed")),
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(saveHermesCommonSetting({
      bots: restartBots,
      botId: "bot-a",
      key: "compressionThreshold",
      value: 0.65,
      getGatewayRestartCommand: async () => "restart",
    })).resolves.toMatchObject({ status: "partial", error: { message: expect.stringContaining("restart failed") } });

    const staleBots = {
      execDebugCommand: vi.fn()
        .mockResolvedValueOnce(succeeded())
        .mockResolvedValueOnce(succeeded())
        .mockResolvedValueOnce(succeeded(snapshotOutput(0.5))),
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(saveHermesCommonSetting({
      bots: staleBots,
      botId: "bot-a",
      key: "compressionThreshold",
      value: 0.65,
      getGatewayRestartCommand: async () => "restart",
    })).resolves.toMatchObject({ status: "partial", error: { message: expect.stringContaining("did not match") } });
  });
});
