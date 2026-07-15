import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstalledSkillLoadState } from "@/lib/hermes-skills-client";
import {
  AutomationSkillBindingSummary,
  AutomationSkillPicker,
} from "../automation-skill-picker";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

afterEach(() => {
  cleanup();
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

describe("AutomationSkillPicker", () => {
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

    expect(trigger).toHaveTextContent("请选择自动任务需要调用的技能");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("请选择自动任务需要调用的技能")).toHaveClass("text-black/35");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("option", { name: "不调用 Skill" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "搜索已安装的技能" }), "NEWS");

    const financeOption = screen.getByRole("option", { name: /Finance News.*finance-news/ });
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
