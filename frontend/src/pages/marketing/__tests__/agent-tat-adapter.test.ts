import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockDebugExecAdapter, createMonoDebugExecAdapter } from "@/pages/marketing/agent-tat-adapter";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
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

  it("posts the transformed command when a lifecycle rewrites it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { status: "SUCCESS", exit_code: 0, output: "done" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createMonoDebugExecAdapter({
      baseUrl: "https://api.example.test",
      commandLifecycle: {
        transformCommand: ({ command }) => `${command}\nhermes config set platforms.qqbot.extra.group_policy open`,
      },
    });

    const run = await adapter.runCommand({
      RegionId: 1,
      InstanceIds: ["bot-1"],
      SaveCommand: false,
      CommandType: "SHELL",
      Content: encodeBase64("acli configure gateway qqbot --app-id '123' --client-secret 'secret'"),
      Timeout: 60,
    });
    await adapter.getInvocationTask(1, run.InvocationId, undefined);

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { command?: string };
    expect(requestBody.command).toBe(
      "acli configure gateway qqbot --app-id '123' --client-secret 'secret'\n" +
      "hermes config set platforms.qqbot.extra.group_policy open",
    );
  });
});

describe("createMockDebugExecAdapter channel status", () => {
  it("keeps Slack connected after the local preview config command succeeds", async () => {
    const adapter = createMockDebugExecAdapter({});

    const configure = await adapter.runCommand({
      RegionId: 1,
      InstanceIds: ["bot-1"],
      SaveCommand: false,
      CommandType: "SHELL",
      Content: encodeBase64("SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test"),
      Timeout: 60,
    });
    await adapter.getInvocationTask(1, configure.InvocationId, undefined);

    const status = await adapter.runCommand({
      RegionId: 1,
      InstanceIds: ["bot-1"],
      SaveCommand: false,
      CommandType: "SHELL",
      Content: encodeBase64("python3 - <<'PY'\nacli channel status\nPY"),
      Timeout: 60,
    });
    const result = await adapter.getInvocationTask(1, status.InvocationId, undefined);
    const output = decodeBase64(result.TaskResult.Output);

    expect(JSON.parse(output)).toEqual({
      success: true,
      data: {
        platforms: [
          {
            name: "slack",
            status: "connected",
          },
        ],
      },
      error: null,
    });
  });

  it("persists Slack connected status across local preview adapter instances", async () => {
    const firstAdapter = createMockDebugExecAdapter({});
    const configure = await firstAdapter.runCommand({
      RegionId: 1,
      InstanceIds: ["bot-1"],
      SaveCommand: false,
      CommandType: "SHELL",
      Content: encodeBase64("SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test"),
      Timeout: 60,
    });
    await firstAdapter.getInvocationTask(1, configure.InvocationId, undefined);

    const secondAdapter = createMockDebugExecAdapter({});
    const status = await secondAdapter.runCommand({
      RegionId: 1,
      InstanceIds: ["bot-1"],
      SaveCommand: false,
      CommandType: "SHELL",
      Content: encodeBase64("acli channel status"),
      Timeout: 60,
    });
    const result = await secondAdapter.getInvocationTask(1, status.InvocationId, undefined);

    expect(JSON.parse(decodeBase64(result.TaskResult.Output)).data.platforms).toContainEqual({
      name: "slack",
      status: "connected",
    });
  });
});

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
