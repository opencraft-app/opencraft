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
    // 后端 message 是中文硬编码：这里特意下发一句「英文环境下不该展示」的后端文案，
    // 用于验证前端不再透传后端 message，而是统一走前端 i18n 文案。
    ensureDesktopSession.mockResolvedValue({
      status: "Installing",
      installProgress: 40,
      message: "后端中文硬编码文案（不应展示）",
    });
    // 轮询保持 Installing，避免进入 Ready 触发 noVNC 动态导入。
    getDesktopSession.mockResolvedValue({
      status: "Installing",
      installProgress: 40,
      message: "后端中文硬编码文案（不应展示）",
    });

    render(<AgentCloudDesktopPanel botId="bot_desktop" />);

    // installing 文案统一走前端 i18n（本测试 useT 原样返回 key 文本），
    // 顶部 + 占位区各一处，故用 findAll。
    const messages = await screen.findAllByText((content) =>
      content.includes("正在安装桌面环境"),
    );
    // 后端 message 不应出现在界面上（已不透传）。
    expect(
      screen.queryByText((content) => content.includes("不应展示")),
    ).toBeNull();
    expect(messages.length).toBeGreaterThan(0);
    // install_progress → 进度百分比展示（{n}% 会被渲染成相邻文本节点，按归一化后文本匹配）。
    const percents = await screen.findAllByText((_content, element) => {
      const text = element?.textContent?.replace(/\s+/g, "") ?? "";
      return text === "40%";
    });
    expect(percents.length).toBeGreaterThan(0);
  });
});
