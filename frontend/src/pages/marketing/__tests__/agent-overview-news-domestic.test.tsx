import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { ensureLocaleDictionary } from "@/i18n";
import { LocaleOverrideProvider } from "@/i18n/t";
import { AgentOverviewPanel } from "@/pages/marketing/agent-overview-panel";

vi.mock("@/lib/region", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/region")>()),
  isCN: true,
  isGlobal: false,
  DEFAULT_LOCALE: "zh-CN",
}));

vi.mock("@/lib/app-navigation", () => ({
  AppLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

afterEach(cleanup);

it("shows the three selected domestic changelog entries in order", async () => {
  await ensureLocaleDictionary("zh-CN");
  render(
    <LocaleOverrideProvider locale="zh-CN">
      <AgentOverviewPanel
        botId="preview" profileId="preview"
        profile={{ name: "Bot", description: "", shapeId: "circle", color: "#10B981" }}
        heroStats={{ servedDays: 2, expiresAt: null, credits: 4500, automations: 0, sites: 0 }}
        execDebugCommand={vi.fn()} onProfileChanged={vi.fn()}
      />
    </LocaleOverrideProvider>,
  );

  const entries = [
    ["LightVela 支持创建多个 Bot", "在同一个 Agent 中创建多个 Bot，让它们各司其职；每个 Bot 的记忆、技能、定时任务、模型和通道配置相互隔离。", "/docs-images/bots-switching-create.webp"],
    ["定时任务新增通知任务和脚本任务", "支持创建通知任务和脚本任务：按原文发送通知，或按计划运行预设脚本。两种任务均不调用模型，模型 Token 消耗为 0。", "/assets/changelog/scheduled-tasks-notification-zh-CN.png"],
    ["LightVela 支持订阅升配", "现有订阅可升配至更高规格，实际应付价格以最终支付页显示为准。", null],
  ] as const;
  const newsSection = screen.getByText("最新动态").closest("section");
  expect(Array.from(newsSection?.querySelectorAll("button") ?? [], (button) => button.getAttribute("aria-label")))
    .toEqual(entries.map(([title]) => title));
  for (const [title, description, image] of entries) {
    fireEvent.click(screen.getByRole("button", { name: title }));
    if (image) expect(screen.getByRole("img", { name: title })).toHaveAttribute("src", image);
    else expect(screen.queryByRole("img", { name: title })).not.toBeInTheDocument();
    expect(screen.getByText(description)).toBeInTheDocument();
    expect(screen.getByText("2026年9月")).toBeInTheDocument();
  }
  expect(screen.queryByRole("button", { name: "LightVela 支持查看 Agent 实例存储空间" })).not.toBeInTheDocument();
});
