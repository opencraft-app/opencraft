import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { InstalledSkillLoadState } from "@/lib/hermes-skills-client";
import { fetchSkillDetail, fetchSkillFile, fetchSkillFiles } from "@/lib/skillhub-api";
import type { AutomationCatalogTemplate } from "../automation-template-catalog";
import {
  AutomationSkillBindingSummary,
  AutomationSkillPicker,
} from "../automation-skill-picker";
import { AutomationFormModal } from "../agent-automations-panel";

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

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperties(HTMLElement.prototype, {
    scrollIntoView: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value() {} },
    setPointerCapture: { configurable: true, value() {} },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function ready(slugs: string[]): InstalledSkillLoadState {
  return { status: "ready", slugs, error: null };
}

function renderPicker({
  value = [],
  loadState = ready(["finance-news", "legal-review"]),
  onChange = vi.fn(),
  onRetry = vi.fn(),
}: {
  value?: string[];
  loadState?: InstalledSkillLoadState;
  onChange?: (slugs: string[]) => void;
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

function renderAutomationFormModal({
  template,
  skillLoadState = ready(["builder-radar", "finance-news"]),
}: {
  template?: AutomationCatalogTemplate;
  skillLoadState?: InstalledSkillLoadState;
} = {}) {
  render(
    <AutomationFormModal
      botId="bot-1"
      mode="create"
      template={template}
      jobs={[]}
      contextCapability="supported"
      onRetryContextCapability={vi.fn()}
      enabledChannels={new Set()}
      channelStatus="ready"
      skillLoadState={skillLoadState}
      onRefreshSkills={async () => skillLoadState}
      onRefreshJobs={async () => []}
      testState="idle"
      onTestRun={vi.fn()}
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

    const tooltip = await screen.findByRole("tooltip");
    const surface = tooltip.closest("[data-slot='tooltip-content']");
    if (!(surface instanceof HTMLElement)) throw new Error("Missing Tooltip surface");

    expect(tooltip).toHaveTextContent(
      "在此处选择技能后，Agent 会在执行任务前加载该技能，相比仅在任务说明中通过提示词要求调用技能更加稳定。",
    );
    expect(helpButton).toHaveAttribute("aria-describedby", tooltip.id);
    expect(helpButton.parentElement).not.toContainElement(surface);
    expect(surface).toHaveClass("agents-ui", "select-text");

    await user.unhover(helpButton);
    await user.hover(surface);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.unhover(surface);
    await user.tab();
    expect(helpButton).toHaveFocus();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("closes and clears the search when clicking outside the picker", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <AutomationSkillPicker
          value={[]}
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

  it("defaults to no Skill and adds a real installed slug after search", async () => {
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
    expect(onChange).toHaveBeenCalledWith(["finance-news"]);
  });

  it("renders every selected Skill as a removable tag", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: ["finance-news", "legal-review"] });
    const financeTag = screen.getByText("Finance News").closest("span");
    const clearButton = screen.getByRole("button", { name: "移除技能 Finance News" });

    expect(financeTag).toBeInTheDocument();
    expect(screen.getByText("Legal Review")).toBeInTheDocument();

    await user.click(clearButton);

    expect(onChange).toHaveBeenCalledWith(["legal-review"]);
  });

  it("keeps the picker open so multiple Skills can be selected in one pass", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: ["finance-news"] });

    await user.click(screen.getByRole("button", { name: "调用技能" }));
    await user.click(screen.getByRole("option", { name: /Legal Review.*legal-review/ }));

    expect(onChange).toHaveBeenCalledWith(["finance-news", "legal-review"]);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
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
    renderPicker({ value: ["removed-skill"], loadState: ready(["finance-news"]) });

    expect(screen.getByText("Removed Skill")).toBeInTheDocument();
    expect(screen.getByText("不可用")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "调用技能" }));
    expect(screen.getByRole("option", { name: /Removed Skill.*不可用/ })).toBeInTheDocument();
  });

  it("does not show an unattended execution warning", () => {
    renderPicker();

    expect(
      screen.queryByText("定时任务在非交互环境中运行，请确认该 Skill 支持无人值守执行"),
    ).not.toBeInTheDocument();
  });
});

describe("AutomationFormModal", () => {
  const competitorTemplate: AutomationCatalogTemplate = {
    id: "competitor-watch",
    source: "hermes",
    name: "竞品动态监控",
    description: "跟踪竞品的重要变化",
    category: "monitoring",
    tags: [],
    prompt: "监控竞品的重要变化。",
    schedule: { kind: "recurring", period: "weekly", time: "10:00" },
    scheduleLabel: "每周定时 · 10:00",
    skills: ["competitor-news-monitor"],
    notificationPolicy: "only-when-needed",
    previewKind: "monitor",
  };

  it("does not preselect a recommended template Skill that is not installed", () => {
    renderAutomationFormModal({ template: competitorTemplate, skillLoadState: ready([]) });

    expect(screen.queryByText("Competitor News Monitor")).not.toBeInTheDocument();
    expect(screen.queryByText("不可用")).not.toBeInTheDocument();
  });

  it("preselects a recommended template Skill when it is installed", () => {
    renderAutomationFormModal({
      template: competitorTemplate,
      skillLoadState: ready(["competitor-news-monitor"]),
    });

    expect(screen.getByText("Competitor News Monitor")).toBeInTheDocument();
    expect(screen.queryByText("不可用")).not.toBeInTheDocument();
  });

  it("opens the controlled one-time date and time picker", async () => {
    const user = userEvent.setup();
    renderAutomationFormModal();

    await user.click(screen.getByRole("button", { name: "选择" }));

    const picker = screen.getByRole("dialog", { name: "执行时间" });
    // Keep the portal layer regression explicit for frontend build verification.
    expect(picker).toHaveClass("agents-ui", "z-[250]");
    expect(picker).toHaveClass("w-[420px]");
    const hourListbox = within(picker).getByRole("listbox", { name: "小时" });
    expect(hourListbox).toBeInTheDocument();
    expect(within(picker).getByRole("listbox", { name: "分钟" })).toBeInTheDocument();
    expect(within(hourListbox).getByRole("option", { name: "00" })).toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: "确认" })).toBeInTheDocument();
  });

  it("matches the task form control radius", () => {
    renderAutomationFormModal();

    const control = screen.getByRole("group", { name: "执行时间" });
    expect(control).toHaveClass(
      "rounded-md",
      "border-black/10",
      "bg-white",
      "w-[220px]",
    );
    expect(within(control).getAllByRole("textbox")).toHaveLength(5);
    expect(control.firstElementChild).toHaveClass("px-2");
    expect(within(control).getByRole("textbox", { name: "执行时间 YYYY" })).toHaveClass("text-sm");
  });

  it("keeps recurring controls compact and wraps multiple daily time inputs", async () => {
    const user = userEvent.setup();
    renderAutomationFormModal();

    await user.click(screen.getByRole("tab", { name: "周期" }));

    const periodControl = screen.getByRole("combobox", { name: "周期" });
    const addTimeButton = screen.getByRole("button", { name: "添加时间" });
    expect(periodControl).toHaveClass("h-9");
    expect(addTimeButton).toHaveClass("size-7");

    for (let index = 0; index < 5; index += 1) {
      await user.click(addTimeButton);
    }

    const timeControls = screen.getAllByRole("group", { name: /^执行时间 \d+$/ });
    expect(timeControls).toHaveLength(6);
    timeControls.forEach((control) => expect(control).toHaveClass("h-9", "w-[140px]"));
    expect(timeControls[0]?.parentElement).toHaveClass("w-[588px]", "max-w-full", "flex-wrap", "gap-1");
    expect(addTimeButton).toHaveClass("size-7");
  });

  it("allows up to eighteen daily time points", async () => {
    const user = userEvent.setup();
    renderAutomationFormModal();

    await user.click(screen.getByRole("tab", { name: "周期" }));
    const addTimeButton = screen.getByRole("button", { name: "添加时间" });
    for (let index = 0; index < 17; index += 1) {
      await user.click(addTimeButton);
    }

    expect(screen.getAllByRole("group", { name: /^执行时间 \d+$/ })).toHaveLength(18);
    expect(screen.getByRole("button", { name: "最多支持18个时间点" })).toHaveAttribute("aria-disabled", "true");
  });

  it("aligns weekly and monthly selectors with their recurring time control", async () => {
    const user = userEvent.setup();
    renderAutomationFormModal();

    await user.click(screen.getByRole("tab", { name: "周期" }));
    await user.click(screen.getByRole("combobox", { name: "周期" }));
    await user.click(screen.getByRole("option", { name: "每周" }));

    const weeklySelection = screen.getByRole("button", { name: "每周" }).parentElement;
    expect(screen.getByRole("combobox", { name: "周期" })).toHaveClass("h-9");
    expect(weeklySelection).toHaveClass("min-h-9", "max-w-full");
    expect(screen.getByRole("group", { name: "执行时间 1" })).toHaveClass("h-9");

    await user.click(screen.getByRole("combobox", { name: "周期" }));
    await user.click(screen.getByRole("option", { name: "每月" }));

    const monthlySelection = screen.getByRole("button", { name: "每月" }).parentElement;
    expect(screen.getByRole("combobox", { name: "周期" })).toHaveClass("h-9");
    expect(monthlySelection).toHaveClass("min-h-9", "max-w-full");
    expect(screen.getByRole("group", { name: "执行时间 1" })).toHaveClass("h-9");
  });

  it("uses compact matching heights for the interval amount and unit", async () => {
    const user = userEvent.setup();
    renderAutomationFormModal();

    await user.click(screen.getByRole("tab", { name: "按间隔" }));

    expect(screen.getByRole("spinbutton")).toHaveClass("h-9");
    expect(screen.getByRole("combobox", { name: "按间隔" })).toHaveClass("h-9");
  });

  it("matches the Name and Skill control radius to the task description", () => {
    renderAutomationFormModal();
    const name = screen.getByPlaceholderText("请输入定时任务名称");
    const prompt = screen.getByPlaceholderText("请描述需要智能体理解并执行的任务，例如：整理每日 AI 资讯并总结关键进展");
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
    const prompt = screen.getByPlaceholderText("请描述需要智能体理解并执行的任务，例如：整理每日 AI 资讯并总结关键进展");

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
    const prompt = screen.getByPlaceholderText("请描述需要智能体理解并执行的任务，例如：整理每日 AI 资讯并总结关键进展");
    await user.type(prompt, "只整理我关注的产品动态");

    await user.click(screen.getByRole("button", { name: "调用技能" }));
    await user.click(screen.getByRole("option", { name: /Builder Radar.*builder-radar/ }));
    await user.click(screen.getByRole("option", { name: /Finance News.*finance-news/ }));
    await user.click(screen.getByRole("button", { name: "移除技能 Builder Radar" }));

    expect(prompt).toHaveValue("只整理我关注的产品动态");
  });
});

describe("AutomationSkillBindingSummary", () => {
  it("renders the no-Skill fallback", () => {
    render(<AutomationSkillBindingSummary value={[]} loadState={ready([])} />);

    expect(screen.getByText("未配置")).toBeInTheDocument();
  });

  it("renders the readable name and persisted slug for an available binding", () => {
    render(<AutomationSkillBindingSummary value={["finance-news"]} loadState={ready(["finance-news"])} />);

    expect(screen.getByText("Finance News")).toBeInTheDocument();
    expect(screen.getByText("finance-news")).toBeInTheDocument();
    expect(screen.queryByText("不可用")).not.toBeInTheDocument();
  });

  it("distinguishes unavailable and unknown bindings", () => {
    const { rerender } = render(
      <AutomationSkillBindingSummary value={["removed-skill"]} loadState={ready([])} />,
    );
    expect(screen.getByText("不可用")).toBeInTheDocument();

    rerender(
      <AutomationSkillBindingSummary
        value={["removed-skill"]}
        loadState={{ status: "loading", slugs: [], error: null }}
      />,
    );
    expect(screen.getByText("状态确认中")).toBeInTheDocument();

    rerender(
      <AutomationSkillBindingSummary
        value={["removed-skill"]}
        loadState={{ status: "error", slugs: [], error: "network failed" }}
      />,
    );
    expect(screen.getByText("暂无法确认")).toBeInTheDocument();
  });

  it("renders every persisted Skill binding", () => {
    render(
      <AutomationSkillBindingSummary
        value={["finance-news", "legal-review"]}
        loadState={ready(["finance-news", "legal-review"])}
      />,
    );

    expect(screen.getByText("Finance News")).toBeInTheDocument();
    expect(screen.getByText("finance-news")).toBeInTheDocument();
    expect(screen.getByText("Legal Review")).toBeInTheDocument();
    expect(screen.getByText("legal-review")).toBeInTheDocument();
  });
});
