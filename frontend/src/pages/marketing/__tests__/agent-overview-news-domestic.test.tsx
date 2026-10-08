import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const renderOverview = () => render(
  <LocaleOverrideProvider locale="zh-CN">
    <AgentOverviewPanel
      botId="preview" profileId="preview"
      profile={{ name: "Bot", description: "", shapeId: "circle", color: "#10B981" }}
      heroStats={{ servedDays: 2, expiresAt: null, credits: 4500, automations: 0, sites: 0 }}
      execDebugCommand={vi.fn()} onProfileChanged={vi.fn()}
    />
  </LocaleOverrideProvider>,
);

/** jsdom 不排版：用 scrollHeight > clientHeight 模拟「两行放不下」 */
const mockDescriptionOverflow = (overflow: boolean) => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(overflow ? 60 : 40);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
};

it("clamps news descriptions to two lines and reveals the full text in a hover tooltip only when truncated", async () => {
  await ensureLocaleDictionary("zh-CN");
  mockDescriptionOverflow(true);
  renderOverview();
  const full = "现在可以在 LightVela 网页中直接与主 Bot 之外的其他 Bot 对话，无需切换到外部聊天通道。";
  const description = screen.getByText(full, { selector: "p" });
  expect(description).toHaveClass("line-clamp-2");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.mouseEnter(screen.getByRole("group", { name: full }));
  expect(screen.getByRole("tooltip")).toHaveTextContent(full);
  // tooltip 渲染到 body，不在被 overflow-hidden 裁切的轮播视口里
  expect(screen.getByRole("tooltip").closest("section")).toBeNull();
});

it("does not attach a tooltip to descriptions that fit in two lines", async () => {
  await ensureLocaleDictionary("zh-CN");
  mockDescriptionOverflow(false);
  renderOverview();
  const newsSection = screen.getByText("产品动态").closest("section")!;
  expect(newsSection.querySelectorAll('[role="group"]')).toHaveLength(0);
  expect(newsSection.querySelectorAll("p.line-clamp-2")).toHaveLength(5);
});

it("pauses the news carousel while the pointer is over the cards", async () => {
  await ensureLocaleDictionary("zh-CN");
  vi.useFakeTimers();
  renderOverview();
  const newsSection = screen.getByText("产品动态").closest("section")!;
  const viewport = newsSection.querySelector("ul")!.parentElement!;
  const firstVisible = () => newsSection.querySelector('li[aria-hidden="false"] p:nth-of-type(2)')?.textContent;
  fireEvent.mouseEnter(viewport);
  act(() => { vi.advanceTimersByTime(15000); });
  expect(firstVisible()).toBe("LightVela 支持与多个 Bot 网页对话");
  fireEvent.mouseLeave(viewport);
  act(() => { vi.advanceTimersByTime(5000); });
  expect(firstVisible()).toBe("聊天通道支持发送测试消息");
});

it("pauses the news carousel while keyboard focus is inside the cards and resumes after focus leaves", async () => {
  await ensureLocaleDictionary("zh-CN");
  mockDescriptionOverflow(true);
  vi.useFakeTimers();
  renderOverview();
  const newsSection = screen.getByText("产品动态").closest("section")!;
  const firstVisible = () => newsSection.querySelector('li[aria-hidden="false"] p:nth-of-type(2)')?.textContent;
  // 截断描述的 tooltip 触发区可聚焦（tabIndex=0）
  const trigger = screen.getByRole("group", { name: "现在可以在 LightVela 网页中直接与主 Bot 之外的其他 Bot 对话，无需切换到外部聊天通道。" });
  act(() => { trigger.focus(); });
  act(() => { vi.advanceTimersByTime(15000); });
  expect(firstVisible()).toBe("LightVela 支持与多个 Bot 网页对话");
  expect(trigger.closest("li")).toHaveAttribute("aria-hidden", "false");
  expect(document.activeElement).toBe(trigger);
  act(() => { trigger.blur(); });
  act(() => { vi.advanceTimersByTime(5000); });
  expect(firstVisible()).toBe("聊天通道支持发送测试消息");
});

it("shows the five most recent domestic changelog entries as text-only cards, two per screen", async () => {
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
    ["2026 年 10 月", "LightVela 支持与多个 Bot 网页对话", "现在可以在 LightVela 网页中直接与主 Bot 之外的其他 Bot 对话，无需切换到外部聊天通道。"],
    ["2026 年 9 月", "聊天通道支持发送测试消息", "已连接的聊天通道可发送一条测试消息，在对应聊天软件中确认是否收到，快速验证消息是否送达。"],
    ["2026 年 9 月", "LightVela 支持套餐升配", "现有套餐可升配至更高规格，实际应付价格以最终支付页显示为准。"],
    ["2026 年 9 月", "LightVela 支持创建多个 Bot", "在同一个 Agent 中创建多个 Bot，让它们各司其职；每个 Bot 的记忆、技能、定时任务、模型和通道配置相互隔离。"],
    ["2026 年 9 月", "定时任务新增通知任务和脚本任务", "支持创建通知任务和脚本任务：按原文发送通知，或按计划运行预设脚本。两种任务均不调用模型，模型 Token 消耗为 0。"],
  ] as const;
  const newsSection = screen.getByText("产品动态").closest("section")!;
  const cards = Array.from(newsSection.querySelectorAll("li"));
  expect(cards.map((card) => Array.from(card.querySelectorAll("p"), (p) => p.textContent))).toEqual(entries.map((entry) => [...entry]));
  expect(newsSection.querySelector("img")).toBeNull();
  expect(cards.filter((card) => card.getAttribute("aria-hidden") !== "true")).toHaveLength(2);
  // 5 条、每屏 2 条、每次滚 1 条 → 4 个停靠位
  expect(newsSection.querySelectorAll("button")).toHaveLength(4);
  expect(screen.queryByText("LightVela 支持查看 Agent 实例存储空间")).not.toBeInTheDocument();
});
