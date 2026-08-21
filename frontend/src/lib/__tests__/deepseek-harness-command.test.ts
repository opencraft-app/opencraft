import { describe, expect, it, vi } from "vitest";

import {
  DEEPSEEK_HARNESS_CN_PROVIDERS,
  DEEPSEEK_HARNESS_GLOBAL_PROVIDERS,
  DeepSeekHarnessCommandClient,
} from "@/lib/deepseek-harness-command";

const success = (output = "") => ({ status: "SUCCESS", exitCode: 0, output });

describe("DeepSeekHarnessCommandClient", () => {
  it("checks the system service through debug/exec", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue(success(JSON.stringify({
      installed: true,
      status: "running",
      service_status: "active",
      healthy: true,
    })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.getStatus()).resolves.toMatchObject({ installed: true, status: "running" });
    expect(execDebugCommand).toHaveBeenCalledWith(
      "bot-1",
      expect.stringContaining("sudo systemctl status deepseek-harness.service --no-pager"),
      expect.any(Object),
    );
  });

  it("starts and polls installation through fixed debug/exec commands", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success(JSON.stringify({
        task_id: "dshi-0123456789abcdef0123456789abcdef",
        status: "running",
        stage: "install_dsh",
        progress: 35,
        message: "installing",
        updated_at: "2026-08-21T00:00:00Z",
      })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand, {
      createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
    });

    const task = await client.startInstall();
    expect(task.task_id).toBe("dshi-0123456789abcdef0123456789abcdef");
    expect(execDebugCommand.mock.calls[0]?.[1]).toContain("sudo -n systemd-run");
    expect(execDebugCommand.mock.calls[0]?.[1]).toContain("install-deepseek-harness install --task-id dshi-0123456789abcdef0123456789abcdef");

    await expect(client.getInstallation(task.task_id)).resolves.toMatchObject({ progress: 35 });
    expect(execDebugCommand.mock.calls[1]?.[1]).toBe(
      "sudo -n /usr/local/libexec/lightvela/install-deepseek-harness installation --task-id dshi-0123456789abcdef0123456789abcdef",
    );
  });

  it("restarts the system service and refreshes status through debug/exec", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success(JSON.stringify({
        installed: true,
        status: "running",
        service_status: "active",
        healthy: true,
      })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.restart()).resolves.toMatchObject({ healthy: true });
    expect(execDebugCommand.mock.calls[0]?.[1]).toBe("sudo systemctl restart deepseek-harness.service");
    expect(execDebugCommand.mock.calls[1]?.[1]).toContain("sudo systemctl status deepseek-harness.service --no-pager");
  });

  it("loads providers and saves API keys through the management helper", async () => {
    const providers = [{
      id: "deepseek",
      displayName: "DeepSeek",
      configured: false,
      active: true,
      writable: true,
    }];
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(success(JSON.stringify({ providers })))
      .mockResolvedValueOnce(success(JSON.stringify({ ok: true, provider: "deepseek", configured: true })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.listProviders("cn")).resolves.toEqual(providers);
    expect(execDebugCommand.mock.calls[0]?.[1]).toBe(
      "sudo -n /usr/local/libexec/lightvela/install-deepseek-harness providers --region cn",
    );

    await client.saveProvider("deepseek", "sk-sensitive-value");
    const saveCommand = String(execDebugCommand.mock.calls[1]?.[1]);
    expect(saveCommand).toContain("configure --provider deepseek");
    expect(saveCommand).not.toContain("sk-sensitive-value");
    expect(saveCommand).toContain(btoa("sk-sensitive-value"));
  });

  it("removes an allowlisted provider through the fixed management command", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue(success(JSON.stringify({
      ok: true,
      provider: "deepseek",
      configured: false,
    })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await client.removeProvider("deepseek");

    expect(execDebugCommand).toHaveBeenCalledWith(
      "bot-1",
      "sudo -n /usr/local/libexec/lightvela/install-deepseek-harness remove-provider --provider deepseek",
      { timeoutMs: 30_000 },
    );
  });

  it("surfaces a failed provider removal instead of pretending it succeeded", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue({
      status: "Failed",
      exitCode: 1,
      output: "DeepSeek credential is managed by the runtime environment and cannot be removed here",
    });
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.removeProvider("deepseek")).rejects.toThrow("managed by the runtime environment");
  });

  it("keeps the exact regional provider allowlists", () => {
    expect(DEEPSEEK_HARNESS_CN_PROVIDERS).toEqual([
      "deepseek",
      "minimax-cn",
      "moonshotai-cn",
      "qwen-token-plan-cn",
      "openrouter",
    ]);
    expect(DEEPSEEK_HARNESS_GLOBAL_PROVIDERS).toEqual([
      "deepseek",
      "minimax",
      "minimax-cn",
      "moonshotai",
      "moonshotai-cn",
      "openrouter",
      "anthropic",
      "groq",
      "openai",
    ]);
  });

  it("rejects task ids and providers outside the fixed allowlists", async () => {
    const execDebugCommand = vi.fn();
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.getInstallation("../../task")).rejects.toThrow("Invalid DeepSeek Harness task id");
    await expect(client.saveProvider("unknown" as "deepseek", "key")).rejects.toThrow("Unsupported DeepSeek Harness provider");
    await expect(client.removeProvider("unknown" as "deepseek")).rejects.toThrow("Unsupported DeepSeek Harness provider");
    expect(execDebugCommand).not.toHaveBeenCalled();
  });
});
