import { afterEach, describe, expect, it, vi } from "vitest";

import { createMonoDebugExecAdapter } from "@/pages/marketing/agent-tat-adapter";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createMonoDebugExecAdapter command lifecycle", () => {
  it("runs the optional hooks before and after a successful command", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { status: "SUCCESS", exit_code: 0, output: "switched" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createMonoDebugExecAdapter({
      baseUrl: "https://api.example.test",
      commandLifecycle: {
        beforeExecute: async ({ botId, command }) => {
          calls.push(`before:${botId}:${command}`);
          return { shouldSync: true };
        },
        afterExecute: async ({ botId, command, metadata, result }) => {
          calls.push(`after:${botId}:${command}:${String((metadata as { shouldSync?: boolean })?.shouldSync)}:${result.status}`);
        },
      },
    });

    const run = await adapter.runCommand({
      RegionId: 1,
      InstanceIds: ["bot-1"],
      SaveCommand: false,
      CommandType: "SHELL",
      Content: encodeBase64("acli model switch --model 'openrouter/model-x'"),
      Timeout: 60,
    });
    const result = await adapter.getInvocationTask(1, run.InvocationId, undefined);

    expect(result.TaskStatus).toBe("SUCCESS");
    expect(calls).toEqual([
      "before:bot-1:acli model switch --model 'openrouter/model-x'",
      "after:bot-1:acli model switch --model 'openrouter/model-x':true:SUCCESS",
    ]);
  });

  it("does not execute the command when the before hook rejects it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createMonoDebugExecAdapter({
      baseUrl: "https://api.example.test",
      commandLifecycle: {
        beforeExecute: async () => {
          throw new Error("cancelled");
        },
      },
    });

    await expect(adapter.runCommand({
      RegionId: 1,
      InstanceIds: ["bot-1"],
      SaveCommand: false,
      CommandType: "SHELL",
      Content: encodeBase64("acli model switch --model 'openrouter/model-x'"),
      Timeout: 60,
    })).rejects.toThrow("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
