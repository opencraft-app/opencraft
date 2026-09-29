import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudDesktopSession } from "@/domain/types";
import { AgentCloudDesktopPanel } from "@/pages/marketing/agent-cloud-desktop-panel";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

const ensureDesktopSession = vi.fn<() => Promise<CloudDesktopSession>>();
const getDesktopSession = vi.fn<() => Promise<CloudDesktopSession>>();

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    bots: {
      ensureDesktopSession,
      getDesktopSession,
    },
  }),
}));

describe("AgentCloudDesktopPanel Installing 进度", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("首次触发返回 Installing 时展示安装文案与进度百分比", async () => {
    ensureDesktopSession.mockResolvedValue({
      status: "Installing",
      installProgress: 40,
      message: "正在安装桌面环境（约 2-4 分钟）",
    });
    // 轮询保持 Installing，避免进入 Ready 触发 noVNC 动态导入。
    getDesktopSession.mockResolvedValue({
      status: "Installing",
      installProgress: 40,
      message: "正在安装桌面环境（约 2-4 分钟）",
    });

    render(<AgentCloudDesktopPanel botId="bot_desktop" />);

    // 后端下发的 message 直接作为状态文案展示（顶部 + 占位区各一处，故用 findAll）。
    const messages = await screen.findAllByText((content) =>
      content.includes("正在安装桌面环境"),
    );
    expect(messages.length).toBeGreaterThan(0);
    // install_progress → 进度百分比展示（{n}% 会被渲染成相邻文本节点，按归一化后文本匹配）。
    const percents = await screen.findAllByText((_content, element) => {
      const text = element?.textContent?.replace(/\s+/g, "") ?? "";
      return text === "40%";
    });
    expect(percents.length).toBeGreaterThan(0);
  });
});
