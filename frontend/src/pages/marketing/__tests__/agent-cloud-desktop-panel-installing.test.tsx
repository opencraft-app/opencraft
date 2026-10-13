import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudDesktopSession } from "@/domain/types";
import i18n from "@/i18n";
import { AgentCloudDesktopPanel } from "@/pages/marketing/agent-cloud-desktop-panel";

const repositories = vi.hoisted(() => ({
  bots: {
    ensureDesktopSession: vi.fn<() => Promise<CloudDesktopSession>>(),
    getDesktopSession: vi.fn<() => Promise<CloudDesktopSession>>(),
  },
}));

vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => repositories }));

function prepare(session: CloudDesktopSession) {
  repositories.bots.ensureDesktopSession.mockResolvedValue(session);
  repositories.bots.getDesktopSession.mockResolvedValue(session);
}

const wallpaper: CloudDesktopSession = {
  status: "Installing", installProgress: 95, installPhase: "configuring_wallpaper",
  message: "后端内部消息 /tmp/private",
};

describe("AgentCloudDesktopPanel 安装阶段与国际化", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    await i18n.changeLanguage("zh-CN");
  });

  it.each([
    { session: { status: "Installing", installProgress: 0 }, text: "正在安装桌面环境（首次约需 2–4 分钟）…", progress: "0%" },
    { session: { status: "Installing", installProgress: 40 }, text: "正在安装桌面环境（首次约需 2–4 分钟）…", progress: "40%" },
    { session: wallpaper, text: "正在配置云电脑壁纸…", progress: "95%" },
    { session: { status: "Provisioning" }, text: "正在启动云电脑（首次约需 1–2 分钟）…", progress: null },
  ] satisfies { session: CloudDesktopSession; text: string; progress: string | null }[])("$text $progress 只在中央占位区展示一次", async ({ session, text, progress }) => {
    prepare(session);
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(text);
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(status.closest(".border-dashed")).not.toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    if (progress !== null) expect(screen.getAllByText(progress)).toHaveLength(1);
  });

  it("英文界面本地化壁纸阶段，不透传后端原始消息", async () => {
    await i18n.changeLanguage("en-US");
    prepare(wallpaper);
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    expect(await screen.findByText("Applying Cloud Computer wallpaper…", { selector: "[role=status]" })).toBeInTheDocument();
    expect(screen.getAllByText("95%").length).toBeGreaterThan(0);
    expect(screen.queryByText(/后端内部消息/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2–4/)).not.toBeInTheDocument();
  });

  it.each([undefined, "installing_desktop", "future_phase"])("阶段 %s 回退本地化安装提示，不按百分比猜壁纸阶段", async (installPhase) => {
    prepare({ status: "Installing", installProgress: 95, installPhase, message: "原始内部信息" });
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    expect(await screen.findByText("正在安装桌面环境（首次约需 2–4 分钟）…", { selector: "[role=status]" })).toBeInTheDocument();
    expect(screen.queryByText("原始内部信息")).not.toBeInTheDocument();
    expect(screen.queryByText("正在配置云电脑壁纸…")).not.toBeInTheDocument();
  });

  it("中文壁纸阶段不继续提示安装组件耗时", async () => {
    prepare(wallpaper);
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    expect(await screen.findByText("正在配置云电脑壁纸…", { selector: "[role=status]" })).toBeInTheDocument();
    expect(screen.queryByText(/首次约需 2–4 分钟/)).not.toBeInTheDocument();
  });

  it("轮询阶段切换后更新提示，转 Provisioning 后移除旧安装进度", async () => {
    vi.useFakeTimers();
    prepare({ status: "Installing", installProgress: 40, installPhase: "installing_desktop" });
    repositories.bots.getDesktopSession.mockResolvedValueOnce(wallpaper).mockResolvedValue({ status: "Provisioning" });
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent("正在安装桌面环境");
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(screen.getByRole("status")).toHaveTextContent("正在配置云电脑壁纸…");
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(screen.getByRole("status")).toHaveTextContent("正在启动云电脑");
    expect(screen.queryByText("95%")).not.toBeInTheDocument();
  });

  it("即使英文界面也优先显示后端 reason，重试清除旧错误", async () => {
    await i18n.changeLanguage("en-US");
    prepare({ status: "Installing", installProgress: 0, installPhase: "installing_desktop" });
    const reason = "安装超时 (last progress error: authentication failed)";
    repositories.bots.ensureDesktopSession.mockResolvedValueOnce({ status: "Failed", reason });
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(reason);
    fireEvent.click(retry);
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("GET 轮询失败也保留 reason，作为纯文本而非 HTML 展示", async () => {
    vi.useFakeTimers();
    prepare({ status: "Installing", installProgress: 40 });
    const reason = "desktop install failed <strong>diagnostic</strong>";
    repositories.bots.getDesktopSession.mockResolvedValue({ status: "Failed", reason });
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(screen.getByRole("alert")).toHaveTextContent(reason);
    expect(screen.getByRole("alert").querySelector("strong")).toBeNull();
  });

  it.each([undefined, "", "   "])("reason 为 %s 时回退本地化失败提示", async (reason) => {
    await i18n.changeLanguage("en-US");
    prepare({ status: "Failed", reason });
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to start cloud computer");
  });

  it("瞬时请求异常有限重试后保留具体错误", async () => {
    vi.useFakeTimers();
    repositories.bots.ensureDesktopSession.mockRejectedValue(new Error("HTTP 502: gateway unavailable"));
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent("正在重新连接");
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    }
    expect(repositories.bots.ensureDesktopSession).toHaveBeenCalledTimes(6);
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 502: gateway unavailable");
  });

  it.each(["ensure", "poll"])("%s 返回 Paused 时停止轮询并要求手动重试", async (stage) => {
    vi.useFakeTimers();
    prepare({ status: stage === "ensure" ? "Paused" : "Provisioning" });
    repositories.bots.getDesktopSession.mockResolvedValue({ status: "Paused" });
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("云电脑已休眠，请点击重试");
    expect(repositories.bots.ensureDesktopSession).toHaveBeenCalledTimes(1);
    expect(repositories.bots.getDesktopSession).toHaveBeenCalledTimes(stage === "ensure" ? 0 : 1);
  });

  it("轮询鉴权失败立即停止，不消耗网络重试预算", async () => {
    vi.useFakeTimers();
    prepare({ status: "Provisioning" });
    repositories.bots.getDesktopSession.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    render(<AgentCloudDesktopPanel botId="bot-test" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("forbidden");
    expect(repositories.bots.getDesktopSession).toHaveBeenCalledTimes(1);
    expect(repositories.bots.ensureDesktopSession).toHaveBeenCalledTimes(1);
  });

  it("卸载时取消安装轮询等待", async () => {
    vi.useFakeTimers();
    prepare({ status: "Installing" });
    const view = render(<AgentCloudDesktopPanel botId="bot-test" />);
    await act(async () => {});
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("首次触发返回 Installing 时展示本地化文案与进度百分比", async () => {
    prepare({ status: "Installing", installProgress: 40, message: "后端中文硬编码文案（不应展示）" });
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    expect(await screen.findByRole("status")).toHaveTextContent("正在安装桌面环境");
    expect(screen.queryByText(/不应展示/)).not.toBeInTheDocument();
    expect(screen.getAllByText("40%").length).toBeGreaterThan(0);
  });
});
