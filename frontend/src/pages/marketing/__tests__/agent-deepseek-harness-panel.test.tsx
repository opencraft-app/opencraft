import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentDeepSeekHarnessPanel,
  DEEPSEEK_HARNESS_LOGO_URL,
} from "@/pages/marketing/agent-deepseek-harness-panel";
import type { DeepSeekHarnessCommandClient } from "@/lib/deepseek-harness-command";

const { api, execDebugCommand, translate } = vi.hoisted(() => ({
  api: {
    getStatus: vi.fn(),
    startInstall: vi.fn(),
    getInstallation: vi.fn(),
    restart: vi.fn(),
  },
  execDebugCommand: vi.fn(),
  translate: vi.fn((text: string) => text),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({ bots: { execDebugCommand } }),
}));
vi.mock("@/components/domain/use-tat-hermes-proxy-broker", () => ({
  useTatHermesProxyBroker: () => ({
    frameUrl: "/__tat_hermes_proxy/dsh--ins-1/",
    status: "ready",
    error: null,
  }),
}));
vi.mock("@/pages/marketing/agent-deepseek-harness-model-card", () => ({
  AgentDeepSeekHarnessModelCard: ({ botId, region }: { botId: string; region: string }) => (
    <section role="region" aria-label="模型配置" data-bot-id={botId} data-region={region} />
  ),
}));
vi.mock("@/i18n/t", () => ({ useT: () => translate }));

const INTRO =
  "DeepSeek Harness（简称：dsh）是由 DeepSeek 开发的一款采用一切皆插件架构的开源智能体框架（Agent Harness）。安装完成后即可通过 LightVela 访问专属 WebUI。";
const NOT_INSTALLED = {
  installed: false,
  status: "not-installed",
  skillhub_installed: false,
  service_status: "inactive",
  healthy: false,
};
const INSTALLED = {
  installed: true,
  status: "running",
  version: "0.1.0-rc.7",
  skillhub_installed: true,
  skillhub_version: "0.2.13",
  service_status: "active",
  healthy: true,
};

describe("AgentDeepSeekHarnessPanel", () => {
  const clientFactory = vi.fn(() => api as unknown as DeepSeekHarnessCommandClient);

  beforeEach(() => {
    localStorage.clear();
    translate.mockClear();
    api.getStatus.mockReset();
    api.startInstall.mockReset();
    api.getInstallation.mockReset();
    api.restart.mockReset();
    api.getStatus.mockResolvedValue(NOT_INSTALLED);
    api.startInstall.mockResolvedValue({ task_id: "dshi-123" });
    api.restart.mockResolvedValue(INSTALLED);
    clientFactory.mockClear();
    execDebugCommand.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("loads the real uninstalled state and keeps the notice above the card", async () => {
    render(<AgentDeepSeekHarnessPanel botId="ins-1" clientFactory={clientFactory} />);

    const card = await screen.findByRole("region", { name: "DeepSeek Harness" });
    expect(card).toHaveClass("min-h-52");
    expect(within(card).getByText(INTRO)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "即刻安装体验" })).toBeEnabled();
    expect(screen.getByRole("note", { name: "抢先体验公告" }).nextElementSibling).toBe(card);
    expect(screen.getByRole("img", { name: "DeepSeek Harness Logo" })).toHaveAttribute(
      "src",
      DEEPSEEK_HARNESS_LOGO_URL,
    );
    expect(clientFactory).toHaveBeenCalledWith("ins-1", execDebugCommand);
    expect(api.getStatus).toHaveBeenCalledWith();
    expect(screen.queryByRole("region", { name: "模型配置" })).not.toBeInTheDocument();
  });

  it("polls the real installation task and fades into the installed card", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    api.getInstallation
      .mockResolvedValueOnce({
        task_id: "dshi-123",
        status: "running",
        stage: "installing",
        progress: 37,
        message: "Installing DSH",
        updated_at: "2026-08-21T10:00:00Z",
      })
      .mockResolvedValueOnce({
        task_id: "dshi-123",
        status: "succeeded",
        stage: "complete",
        progress: 100,
        message: "Installed",
        updated_at: "2026-08-21T10:01:00Z",
      });
    api.getStatus.mockResolvedValueOnce(NOT_INSTALLED).mockResolvedValueOnce(INSTALLED);
    render(<AgentDeepSeekHarnessPanel botId="ins-1" clientFactory={clientFactory} />);
    await screen.findByRole("button", { name: "即刻安装体验" });

    await user.click(screen.getByRole("button", { name: "即刻安装体验" }));
    const progress = await screen.findByRole("progressbar", { name: "DeepSeek Harness 安装进度" });
    expect(progress).toHaveAttribute("aria-valuenow", "37");
    expect(localStorage.getItem("lightvela:dsh:install-task:ins-1")).toBe("dshi-123");
    expect(screen.getByText("请稍等片刻，安装大约需要 1-3 分钟")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(260);
    });
    const card = screen.getByRole("region", { name: "DeepSeek Harness" });
    expect(card).toHaveClass("opacity-0");
    fireEvent.transitionEnd(card, { propertyName: "opacity" });
    expect(within(card).getByRole("group", { name: "DeepSeek Harness 运行信息" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    fireEvent.transitionEnd(card, { propertyName: "opacity" });
    expect(screen.getByRole("region", { name: "模型配置" })).toHaveAttribute("data-bot-id", "ins-1");
    expect(localStorage.getItem("lightvela:dsh:install-task:ins-1")).toBeNull();
  });

  it("renders the installed state with proxied WebUI access, restart, and model configuration", async () => {
    const user = userEvent.setup();
    let resolveRestart: (value: typeof INSTALLED) => void = () => undefined;
    api.restart.mockReturnValue(new Promise((resolve) => {
      resolveRestart = resolve;
    }));
    api.getStatus.mockResolvedValue(INSTALLED);
    render(<AgentDeepSeekHarnessPanel botId="ins-1" clientFactory={clientFactory} />);

    const runtime = await screen.findByRole("group", { name: "DeepSeek Harness 运行信息" });
    expect(screen.getByRole("region", { name: "DeepSeek Harness" })).not.toHaveClass("min-h-52");
    expect(within(runtime).getByText("运行中")).toBeInTheDocument();
    expect(screen.queryByText(INTRO)).not.toBeInTheDocument();
    const webUi = within(runtime).getByRole("link", { name: "访问 WebUI" });
    expect(webUi).toHaveAttribute("href", "/__tat_hermes_proxy/dsh--ins-1/");
    expect(webUi).toHaveAttribute("target", "_blank");
    expect(webUi.getAttribute("href")).not.toMatch(/^https?:/);
    expect(screen.getByRole("region", { name: "模型配置" })).toHaveAttribute("data-region", "cn");

    await user.click(within(runtime).getByRole("button", { name: "重启" }));
    expect(within(runtime).getByRole("button", { name: "重启中..." })).toBeDisabled();
    expect(api.restart).toHaveBeenCalledWith();
    await act(async () => resolveRestart(INSTALLED));
    expect(await within(runtime).findByRole("button", { name: "重启" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("DeepSeek Harness 已重新启动");
  });

  it("recovers a persisted task after refresh and shows a retryable failure", async () => {
    localStorage.setItem("lightvela:dsh:install-task:ins-1", "dshi-existing");
    api.getInstallation.mockResolvedValue({
      task_id: "dshi-existing",
      status: "failed",
      stage: "rollback",
      progress: 61,
      message: "Install failed",
      error: "package download failed",
      updated_at: "2026-08-21T10:00:00Z",
    });
    render(<AgentDeepSeekHarnessPanel botId="ins-1" clientFactory={clientFactory} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("package download failed");
    expect(api.getInstallation).toHaveBeenCalledWith("dshi-existing");
    expect(screen.getByRole("button", { name: "重新尝试安装" })).toBeEnabled();
    expect(localStorage.getItem("lightvela:dsh:install-task:ins-1")).toBeNull();
  });

  it("lets the user retry when the initial status request fails", async () => {
    const user = userEvent.setup();
    api.getStatus.mockRejectedValueOnce(new Error("status unavailable")).mockResolvedValueOnce(NOT_INSTALLED);
    render(<AgentDeepSeekHarnessPanel botId="ins-1" clientFactory={clientFactory} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("status unavailable");
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("button", { name: "即刻安装体验" })).toBeEnabled();
    expect(api.getStatus).toHaveBeenCalledTimes(2);
  });
});
