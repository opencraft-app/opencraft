import { describe, expect, it, vi } from "vitest";
import type { BotRepository } from "@/repositories/types";

import {
  HERMES_MEMORY_COMMAND_TIMEOUT_MS,
  HERMES_MEMORY_JSON_END,
  HERMES_MEMORY_JSON_START,
} from "../agent-memory";
import {
  canStartHermesMemoryLimitSave,
  isHermesMemoryOperationCurrent,
  saveHermesMemoryLimit,
} from "../agent-memory-save";

const snapshotOutput = (memoryCharLimit = 2400) => [
  HERMES_MEMORY_JSON_START,
  JSON.stringify({
    memoryCharLimit,
    userCharLimit: 1375,
    memoryChars: 1200,
    userChars: 600,
    memoryText: "project context",
    userText: "user preference",
    usedFallbackLimits: false,
  }),
  HERMES_MEMORY_JSON_END,
].join("\n");

const succeeded = (output = "") => ({ status: "Succeeded", exitCode: 0, output });
const failed = (output: string) => ({ status: "Failed", exitCode: 1, output });

describe("saveHermesMemoryLimit", () => {
  it("returns success after config, restart, and verified reread all succeed", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded(snapshotOutput()));
    const bots = { execDebugCommand } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    const result = await saveHermesMemoryLimit({
      bots,
      botId: "bot-a",
      target: "memory",
      value: 2400,
      existingChars: 1200,
      getGatewayRestartCommand: async () => "hermes gateway restart",
    });

    expect(result).toMatchObject({ status: "success", snapshot: { memoryCharLimit: 2400 } });
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      1,
      "bot-a",
      "hermes config set memory.memory_char_limit 2400",
      { timeoutMs: HERMES_MEMORY_COMMAND_TIMEOUT_MS },
    );
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      2,
      "bot-a",
      "hermes gateway restart",
      { timeoutMs: HERMES_MEMORY_COMMAND_TIMEOUT_MS },
    );
    expect(execDebugCommand.mock.calls[2]?.[2]).toEqual({ timeoutMs: HERMES_MEMORY_COMMAND_TIMEOUT_MS });
  });

  it("returns failed when the config command does not succeed", async () => {
    const bots = {
      execDebugCommand: vi.fn().mockResolvedValue(failed("config permission denied")),
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    const result = await saveHermesMemoryLimit({
      bots,
      botId: "bot-a",
      target: "user",
      value: 1500,
      existingChars: 600,
      getGatewayRestartCommand: async () => "hermes gateway restart",
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("config permission denied") },
    });
  });

  it.each([
    ["restart command provider", async () => { throw new Error("SDK unavailable"); }],
    ["restart request", async () => "hermes gateway restart"],
  ])("returns partial after config is saved but %s fails", async (stage, getGatewayRestartCommand) => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(failed("restart failed"));
    const bots = { execDebugCommand } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    const result = await saveHermesMemoryLimit({
      bots,
      botId: "bot-a",
      target: "memory",
      value: 2400,
      existingChars: 1200,
      getGatewayRestartCommand,
    });

    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.error.message).toContain(stage === "restart command provider" ? "SDK unavailable" : "restart failed");
    }
  });

  it("returns partial when reread fails or does not confirm the saved limit", async () => {
    const rereadFailureBots = {
      execDebugCommand: vi.fn()
        .mockResolvedValueOnce(succeeded())
        .mockResolvedValueOnce(succeeded())
        .mockResolvedValueOnce(failed("read failed")),
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    const failedRead = await saveHermesMemoryLimit({
      bots: rereadFailureBots,
      botId: "bot-a",
      target: "memory",
      value: 2400,
      existingChars: 1200,
      getGatewayRestartCommand: async () => "hermes gateway restart",
    });
    expect(failedRead).toMatchObject({
      status: "partial",
      error: { message: expect.stringContaining("read failed") },
    });

    const staleReadBots = {
      execDebugCommand: vi.fn()
        .mockResolvedValueOnce(succeeded())
        .mockResolvedValueOnce(succeeded())
        .mockResolvedValueOnce(succeeded(snapshotOutput(2200))),
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    const staleRead = await saveHermesMemoryLimit({
      bots: staleReadBots,
      botId: "bot-a",
      target: "memory",
      value: 2400,
      existingChars: 1200,
      getGatewayRestartCommand: async () => "hermes gateway restart",
    });
    expect(staleRead).toMatchObject({
      status: "partial",
      error: { message: expect.stringContaining("did not match") },
    });
  });
});

describe("Hermes memory save request scope", () => {
  it("accepts the latest request for the active Agent", () => {
    expect(isHermesMemoryOperationCurrent({
      activeBotId: "bot-a",
      requestedBotId: "bot-a",
      latestRequestId: 7,
      requestId: 7,
    })).toBe(true);
  });

  it("rejects an old request after the active Agent changes", () => {
    expect(isHermesMemoryOperationCurrent({
      activeBotId: "bot-b",
      requestedBotId: "bot-a",
      latestRequestId: 7,
      requestId: 7,
    })).toBe(false);
  });

  it("rejects an older request for the same Agent", () => {
    expect(isHermesMemoryOperationCurrent({
      activeBotId: "bot-a",
      requestedBotId: "bot-a",
      latestRequestId: 8,
      requestId: 7,
    })).toBe(false);
  });

  it("only allows a save to start when no other target is in flight", () => {
    expect(canStartHermesMemoryLimitSave(null)).toBe(true);
    expect(canStartHermesMemoryLimitSave("memory")).toBe(false);
    expect(canStartHermesMemoryLimitSave("user")).toBe(false);
  });
});
