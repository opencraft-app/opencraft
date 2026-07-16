import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstalledSkillLoadState } from "@/lib/hermes-skills-client";
import { fetchSkillDetail, fetchSkillFile, fetchSkillFiles } from "@/lib/skillhub-api";
import {
  AutomationSkillBindingSummary,
  AutomationSkillPicker,
} from "../automation-skill-picker";
import { AutomationFormModal } from "../hermes-agent-automations-panel";

vi.mock("@/lib/skillhub-api", () => ({
  fetchSkillFiles: vi.fn(async () => [{ path: "SKILL.md", size: 1, sha256: "abc" }]),
  fetchSkillFile: vi.fn(async (slug: string) => slug === "builder-radar"
    ? "## Best-practice invocations\n\n```text\n执行 Builder Radar 的 Daily Deep 模式。\n```"
    : "## Best-practice invocations\n\n```text\n执行 Finance News 的每日摘要模式。\n```"),
  fetchSkillDetail: vi.fn(async () => ({
    slug: "builder-radar",
    displayName: "Builder Radar",
    summary: "整理 AI Builder 前沿信息。",
  })),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function ready(slugs: string[]): InstalledSkillLoadState {
  return { status: "ready", slugs, error: null };
}

function renderPicker({
  value = "",
  loadState = ready(["finance-news", "legal-review"]),
  onChange = vi.fn(),
  onRetry = vi.fn(),
}: {
  value?: string;
  loadState?: InstalledSkillLoadState;
  onChange?: (slug: string) => void;
  onRetry?: () => void;
} = {}) {
  render(
    <AutomationSkillPicker
      value={value}
      loadState={loadState}
      onChange={onChange}
      onRetry={onRetry}
    />,
  );
  return { onChange, onRetry };
}

function renderAutomationFormModal() {
  render(
    <AutomationFormModal
      botId="bot-1"
      mode="create"
      enabledChannels={new Set()}
      channelStatus="ready"
      skillLoadState={ready(["builder-radar", "finance-news"])}
      onRefreshSkills={async () => ready(["builder-radar", "finance-news"])}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      onError={vi.fn()}
    />,
  );
}

describe("AutomationSkillPicker", () => {
  it("explains why selecting a Skill is more reliable than prompt-only invocation", async () => {
    const user = userEvent.setup();
    renderPicker();
    const helpButton = screen.getByRole("button", { name: "为什么选择调用技能更稳定" });

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(helpButton);

    const tooltip = screen.getByRole("tooltip");

    expect(tooltip).toHaveTextContent(
      "在此处选择技能后，Agent 会在执行任务前加载该技能，相比仅在任务说明中通过提示词要求调用技能更加稳定。",
    );
    expect(helpButton).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveClass("fixed");

    await user.unhover(helpButton);
    await user.hover(tooltip);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.unhover(tooltip);
    await user.tab();
    expect(helpButton).toHaveFocus();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("closes and clears the search when clicking outside the picker", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <AutomationSkillPicker
          value=""
          loadState={ready(["finance-news", "legal-review"])}
          onChange={vi.fn()}
          onRetry={vi.fn()}
        />
        <button type="button">弹窗空白区域</button>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "调用技能" });

    await user.click(trigger);
    await user.type(screen.getByRole("searchbox", { name: "搜索已安装的技能" }), "news");
    await user.click(screen.getByRole("button", { name: "弹窗空白区域" }));

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("searchbox", { name: "搜索已安装的技能" })).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByText("Legal Review")).toBeInTheDocument();
  });

  it("defaults to no Skill and selects a real installed slug after search", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();
    const trigger = screen.getByRole("button", { name: "调用技能" });

    expect(trigger).toHaveTextContent("选择你希望 Agent 稳定调用的技能");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("选择你希望 Agent 稳定调用的技能")).toHaveClass("text-black/35");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("option", { name: "不调用 Skill" })).not.toBeInTheDocument();
    const listbox = screen.getByRole("listbox", { name: "已安装 Skill" });
    const searchbox = screen.getByRole("searchbox", { name: "搜索已安装的技能" });
    expect(listbox).toHaveClass("max-h-48", "p-1");
    expect(searchbox.parentElement).toHaveClass("py-1.5");
    expect(searchbox.parentElement?.parentElement).toHaveClass("p-1.5");
    await user.type(searchbox, "NEWS");

    const financeOption = screen.getByRole("option", { name: /Finance News.*finance-news/ });
    expect(financeOption).toHaveClass("py-1.5");
    const optionName = within(financeOption).getByText("Finance News");
    const optionSlug = within(financeOption).getByText("finance-news");
    expect(optionName.parentElement).toBe(optionSlug.parentElement);
    expect(optionName.parentElement).toHaveClass("flex");
    expect(optionName).not.toHaveClass("block");
    expect(optionSlug).not.toHaveClass("block");
    expect(screen.queryByText("Legal Review")).not.toBeInTheDocument();

    await user.click(financeOption);
    expect(onChange).toHaveBeenCalledWith("finance-news");
  });

  it("turns the selected dropdown icon into a clear action on hover", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: "finance-news" });
    const trigger = screen.getByRole("button", { name: "调用技能" });
    const clearButton = screen.getByRole("button", { name: "移除已选择的技能" });
    const icons = clearButton.querySelectorAll("svg");

    expect(icons).toHaveLength(2);
    expect(icons[0]).toHaveClass("group-hover/clear:opacity-0");
    expect(icons[1]).toHaveClass("group-hover/clear:opacity-100");

    await user.click(clearButton);

    expect(onChange).toHaveBeenCalledWith("");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows loading without adding a no-Skill option", async () => {
    const user = userEvent.setup();
    renderPicker({ loadState: { status: "loading", slugs: [], error: null } });

    await user.click(screen.getByRole("button", { name: "调用技能" }));

    expect(screen.getByText("加载中...")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "不调用 Skill" })).not.toBeInTheDocument();
  });

  it("shows an empty state and links to Agent Skill management", async () => {
    const user = userEvent.setup();
    renderPicker({ loadState: ready([]) });

    await user.click(screen.getByRole("button", { name: "调用技能" }));

    expect(screen.getByText("暂无已安装 Skill")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往技能管理" })).toHaveAttribute("href", "/agents/skills");
  });

  it("shows a retry action after load failure", async () => {
    const user = userEvent.setup();
    const { onRetry } = renderPicker({
      loadState: { status: "error", slugs: [], error: "network failed" },
    });

    await user.click(screen.getByRole("button", { name: "调用技能" }));
    expect(screen.getByText("Skill 列表加载失败")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("preserves and marks an installed binding that is now unavailable", async () => {
    const user = userEvent.setup();
    renderPicker({ value: "removed-skill", loadState: ready(["finance-news"]) });

    expect(screen.getByRole("button", { name: "调用技能" })).toHaveTextContent("Removed Skill");
    expect(screen.getByText("不可用")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "调用技能" }));
    expect(screen.getByRole("option", { name: /Removed Skill.*不可用/ })).toBeInTheDocument();
  });

  it("does not show an unattended execution warning", () => {
    renderPicker();

    expect(
      screen.queryByText("自动任务在非交互环境中运行，请确认该 Skill 支持无人值守执行"),
    ).not.toBeInTheDocument();
  });
});

describe("AutomationFormModal Skill selection", () => {
  it("matches the Name and Skill control radius to the task description", () => {
    renderAutomationFormModal();
    const name = screen.getByPlaceholderText("请输入自动任务名称");
    const prompt = screen.getByPlaceholderText("请用提示词的形式描述需要执行的任务，比如：提醒我喝水，或者使用 xxx 技能帮我执行任务等");
    const skill = screen.getByRole("button", { name: "调用技能" });

    expect(prompt).toHaveClass("rounded-md");
    expect(name).toHaveClass("rounded-md");
    expect(name).not.toHaveClass("rounded-lg");
    expect(skill).toHaveClass("rounded-md");
    expect(skill).not.toHaveClass("rounded-lg");
  });

  it("does not generate a task description after selecting a Skill", async () => {
    const user = userEvent.setup();
    renderAutomationFormModal();
    const prompt = screen.getByPlaceholderText("请用提示词的形式描述需要执行的任务，比如：提醒我喝水，或者使用 xxx 技能帮我执行任务等");

    await user.click(screen.getByRole("button", { name: "调用技能" }));
    await user.click(screen.getByRole("option", { name: /Builder Radar.*builder-radar/ }));

    expect(prompt).toHaveValue("");
    expect(fetchSkillFiles).not.toHaveBeenCalled();
    expect(fetchSkillFile).not.toHaveBeenCalled();
    expect(fetchSkillDetail).not.toHaveBeenCalled();
  });

  it("keeps the task description unchanged when selecting, switching or clearing Skills", async () => {
    const user = userEvent.setup();
    renderAutomationFormModal();
    const prompt = screen.getByPlaceholderText("请用提示词的形式描述需要执行的任务，比如：提醒我喝水，或者使用 xxx 技能帮我执行任务等");
    await user.type(prompt, "只整理我关注的产品动态");

    await user.click(screen.getByRole("button", { name: "调用技能" }));
    await user.click(screen.getByRole("option", { name: /Builder Radar.*builder-radar/ }));
    await user.click(screen.getByRole("button", { name: "调用技能" }));
    await user.click(screen.getByRole("option", { name: /Finance News.*finance-news/ }));
    await user.click(screen.getByRole("button", { name: "移除已选择的技能" }));

    expect(prompt).toHaveValue("只整理我关注的产品动态");
  });
});

describe("AutomationSkillBindingSummary", () => {
  it("renders the no-Skill fallback", () => {
    render(<AutomationSkillBindingSummary value="" loadState={ready([])} />);

    expect(screen.getByText("不调用 Skill")).toBeInTheDocument();
  });

  it("renders the readable name and persisted slug for an available binding", () => {
    render(<AutomationSkillBindingSummary value="finance-news" loadState={ready(["finance-news"])} />);

    expect(screen.getByText("Finance News")).toBeInTheDocument();
    expect(screen.getByText("finance-news")).toBeInTheDocument();
    expect(screen.queryByText("不可用")).not.toBeInTheDocument();
  });

  it("distinguishes unavailable and unknown bindings", () => {
    const { rerender } = render(
      <AutomationSkillBindingSummary value="removed-skill" loadState={ready([])} />,
    );
    expect(screen.getByText("不可用")).toBeInTheDocument();

    rerender(
      <AutomationSkillBindingSummary
        value="removed-skill"
        loadState={{ status: "loading", slugs: [], error: null }}
      />,
    );
    expect(screen.getByText("状态确认中")).toBeInTheDocument();

    rerender(
      <AutomationSkillBindingSummary
        value="removed-skill"
        loadState={{ status: "error", slugs: [], error: "network failed" }}
      />,
    );
    expect(screen.getByText("暂无法确认")).toBeInTheDocument();
  });
});
