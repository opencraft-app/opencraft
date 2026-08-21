import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DeepSeekHarnessCommandClient,
  DeepSeekHarnessProvider,
} from "@/lib/deepseek-harness-command";
import { AgentDeepSeekHarnessModelCard } from "@/pages/marketing/agent-deepseek-harness-model-card";

const { execDebugCommand, repositories } = vi.hoisted(() => ({
  execDebugCommand: vi.fn(),
  repositories: { bots: { execDebugCommand: vi.fn() } },
}));
const { translate } = vi.hoisted(() => ({
  translate: (text: string, options?: Record<string, unknown>) => text.replace(
    /\{\{(\w+)\}\}/g,
    (_match, key: string) => String(options?.[key] ?? ""),
  ),
}));
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositories,
}));

vi.mock("@/i18n/t", () => ({ useT: () => translate }));
vi.mock("@/lib/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

const providers: DeepSeekHarnessProvider[] = [
  { id: "deepseek", displayName: "DeepSeek", configured: true, active: true, writable: true },
  { id: "minimax-cn", displayName: "MiniMax CN", configured: false, active: true, writable: true },
  { id: "openrouter", displayName: "OpenRouter", configured: false, active: true, writable: true },
];

describe("AgentDeepSeekHarnessModelCard", () => {
  const listProviders = vi.fn();
  const saveProvider = vi.fn();
  const removeProvider = vi.fn();
  const clientFactory = vi.fn(() => ({
    listProviders,
    saveProvider,
    removeProvider,
  }) as unknown as DeepSeekHarnessCommandClient);

  beforeEach(() => {
    repositories.bots.execDebugCommand = execDebugCommand;
    execDebugCommand.mockReset();
    listProviders.mockReset();
    listProviders.mockResolvedValue(providers);
    saveProvider.mockReset();
    saveProvider.mockResolvedValue(undefined);
    removeProvider.mockReset();
    removeProvider.mockResolvedValue(undefined);
    clientFactory.mockClear();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  afterEach(cleanup);

  it("keeps configured providers visible and includes every provider in the configuration selector", async () => {
    const user = userEvent.setup();
    render(<AgentDeepSeekHarnessModelCard botId="ins-1" region="cn" clientFactory={clientFactory} />);

    const configuredList = await screen.findByRole("list", { name: "已配置模型供应商" });
    expect(within(configuredList).getByText("DeepSeek")).toBeInTheDocument();
    expect(within(configuredList).getByText("已配置")).toBeInTheDocument();
    expect(clientFactory).toHaveBeenCalledWith("ins-1", execDebugCommand);
    expect(listProviders).toHaveBeenCalledWith("cn");

    await user.click(screen.getByRole("button", { name: /模型供应商 DeepSeek/ }));
    const options = screen.getByRole("listbox", { name: "模型供应商" });
    expect(within(options).getByRole("option", { name: "DeepSeek" })).toBeInTheDocument();
    expect(within(options).getByRole("option", { name: "MiniMax CN" })).toBeInTheDocument();
    expect(within(options).getByRole("option", { name: "OpenRouter" })).toBeInTheDocument();
    expect(screen.getByText("配置模型供应商")).toBeInTheDocument();
    expect(screen.queryByText(/^Provider$/)).not.toBeInTheDocument();
  });

  it("adds an unconfigured provider without echoing or retaining its key", async () => {
    const user = userEvent.setup();
    render(<AgentDeepSeekHarnessModelCard botId="ins-1" region="cn" clientFactory={clientFactory} />);
    await screen.findByRole("list", { name: "已配置模型供应商" });

    const updated = providers.map((provider) => (
      provider.id === "minimax-cn" ? { ...provider, configured: true } : provider
    ));
    listProviders.mockResolvedValueOnce(updated);
    await user.click(screen.getByRole("button", { name: /模型供应商 DeepSeek/ }));
    await user.click(screen.getByRole("option", { name: "MiniMax CN" }));
    const keyInput = screen.getByLabelText("MiniMax CN API 密钥");
    await user.type(keyInput, "secret-minimax");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(saveProvider).toHaveBeenCalledWith("minimax-cn", "secret-minimax");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("MiniMax CN 配置已保存"));
    expect(screen.getByRole("list", { name: "已配置模型供应商" })).toHaveTextContent("MiniMax CN");
    expect(screen.queryByText("secret-minimax")).not.toBeInTheDocument();
    expect(screen.getByLabelText("MiniMax CN API 密钥")).toHaveValue("");
  });

  it("keeps the form busy until exec returns and then clears the credential", async () => {
    const user = userEvent.setup();
    let resolveSave: (() => void) | undefined;
    saveProvider.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    listProviders.mockResolvedValueOnce(providers);
    render(<AgentDeepSeekHarnessModelCard botId="ins-1" region="cn" clientFactory={clientFactory} />);
    await screen.findByRole("list", { name: "已配置模型供应商" });

    const keyInput = screen.getByLabelText("DeepSeek API 密钥");
    await user.type(keyInput, "replacement-key");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(screen.getByRole("button", { name: "保存中..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: /模型供应商 DeepSeek/ })).toBeDisabled();
    expect(keyInput).toBeDisabled();
    expect(toastSuccess).not.toHaveBeenCalled();

    resolveSave?.();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("DeepSeek 配置已保存"));
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
    expect(screen.getByLabelText("DeepSeek API 密钥")).toHaveValue("");
  });

  it("overwrites a configured provider selected from the complete catalog", async () => {
    const user = userEvent.setup();
    render(<AgentDeepSeekHarnessModelCard botId="ins-1" region="cn" clientFactory={clientFactory} />);
    await screen.findByRole("list", { name: "已配置模型供应商" });

    const keyInput = screen.getByLabelText("DeepSeek API 密钥");
    await user.type(keyInput, "new-deepseek-key");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(saveProvider).toHaveBeenCalledWith("deepseek", "new-deepseek-key");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("DeepSeek 配置已保存"));
    expect(screen.getByRole("button", { name: /模型供应商 DeepSeek/ })).toBeInTheDocument();
  });

  it("uses a global error toast and keeps the credential when saving fails", async () => {
    const user = userEvent.setup();
    saveProvider.mockRejectedValueOnce(new Error("配置命令执行失败"));
    render(<AgentDeepSeekHarnessModelCard botId="ins-1" region="cn" clientFactory={clientFactory} />);
    await screen.findByRole("list", { name: "已配置模型供应商" });

    const keyInput = screen.getByLabelText("DeepSeek API 密钥");
    await user.type(keyInput, "retry-key");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("配置命令执行失败"));
    expect(keyInput).toHaveValue("retry-key");
  });

  it("edits one configured provider at a time and keeps an empty key unchanged", async () => {
    const user = userEvent.setup();
    const configuredProviders = providers.map((provider) => (
      provider.id === "openrouter" ? { ...provider, configured: true } : provider
    ));
    listProviders.mockResolvedValue(configuredProviders);
    render(<AgentDeepSeekHarnessModelCard botId="ins-1" region="cn" clientFactory={clientFactory} />);
    const configuredList = await screen.findByRole("list", { name: "已配置模型供应商" });

    await user.click(screen.getByRole("button", { name: "编辑 DeepSeek" }));
    expect(within(configuredList).getByLabelText("DeepSeek API 密钥")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "编辑 OpenRouter" }));
    expect(within(configuredList).queryByLabelText("DeepSeek API 密钥")).not.toBeInTheDocument();
    expect(within(configuredList).getByLabelText("OpenRouter API 密钥")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存修改" }));
    expect(saveProvider).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("已保留现有 API 密钥");
  });

  it("deletes a configured provider after confirmation and returns it to the add selector", async () => {
    const user = userEvent.setup();
    render(<AgentDeepSeekHarnessModelCard botId="ins-1" region="cn" clientFactory={clientFactory} />);
    await screen.findByRole("list", { name: "已配置模型供应商" });

    await user.click(screen.getByRole("button", { name: "删除 DeepSeek" }));
    const dialog = screen.getByRole("alertdialog", { name: "删除 DeepSeek？" });
    expect(within(dialog).getByText(/不会删除环境变量或自定义凭据/)).toBeInTheDocument();

    listProviders.mockResolvedValueOnce(providers.map((provider) => (
      provider.id === "deepseek" ? { ...provider, configured: false } : provider
    )));
    await user.click(within(dialog).getByRole("button", { name: "确认删除 DeepSeek" }));

    expect(removeProvider).toHaveBeenCalledWith("deepseek");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("DeepSeek 已删除"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /模型供应商 DeepSeek/ }));
    expect(screen.getByRole("option", { name: "DeepSeek" })).toBeInTheDocument();
  });

  it("keeps the confirmation open when deletion fails and allows retry", async () => {
    const user = userEvent.setup();
    removeProvider
      .mockRejectedValueOnce(new Error("该凭据由运行环境管理，无法在此删除"))
      .mockResolvedValueOnce(undefined);
    render(<AgentDeepSeekHarnessModelCard botId="ins-1" region="cn" clientFactory={clientFactory} />);
    await screen.findByRole("list", { name: "已配置模型供应商" });

    await user.click(screen.getByRole("button", { name: "删除 DeepSeek" }));
    const dialog = screen.getByRole("alertdialog", { name: "删除 DeepSeek？" });
    const confirm = within(dialog).getByRole("button", { name: "确认删除 DeepSeek" });
    await user.click(confirm);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("该凭据由运行环境管理，无法在此删除");
    expect(screen.getByRole("alertdialog", { name: "删除 DeepSeek？" })).toBeInTheDocument();

    listProviders.mockResolvedValueOnce(providers.map((provider) => (
      provider.id === "deepseek" ? { ...provider, configured: false } : provider
    )));
    await user.click(confirm);
    expect(removeProvider).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("DeepSeek 已删除"));
  });

  it("shows a recoverable error when the DSH configuration cannot be loaded", async () => {
    const user = userEvent.setup();
    listProviders.mockRejectedValueOnce(new Error("DSH is starting"));
    render(<AgentDeepSeekHarnessModelCard botId="ins-1" region="cn" clientFactory={clientFactory} />);

    expect(await screen.findByText("DSH is starting")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("list", { name: "已配置模型供应商" })).toBeInTheDocument();
    expect(listProviders).toHaveBeenCalledTimes(2);
  });
});
