import { cleanup, render, screen } from "@testing-library/react";
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
  it("defaults to no Skill and selects a real installed slug after search", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();
    const trigger = screen.getByRole("button", { name: "调用 Skill" });

    expect(trigger).toHaveTextContent("不调用 Skill");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.type(screen.getByRole("searchbox", { name: "搜索已安装 Skill" }), "NEWS");

    expect(screen.getByText("Finance News")).toBeInTheDocument();
    expect(screen.getByText("finance-news")).toBeInTheDocument();
    expect(screen.queryByText("Legal Review")).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Finance News/ }));
    expect(onChange).toHaveBeenCalledWith("finance-news");
  });

  it("lets an existing binding return to no Skill", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: "finance-news" });

    await user.click(screen.getByRole("button", { name: "调用 Skill" }));
    await user.click(screen.getByRole("option", { name: "不调用 Skill" }));

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("shows loading without removing the no-Skill option", async () => {
    const user = userEvent.setup();
    renderPicker({ loadState: { status: "loading", slugs: [], error: null } });

    await user.click(screen.getByRole("button", { name: "调用 Skill" }));

    expect(screen.getByText("加载中...")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "不调用 Skill" })).toBeInTheDocument();
  });

  it("shows an empty state and links to Agent Skill management", async () => {
    const user = userEvent.setup();
    renderPicker({ loadState: ready([]) });

    await user.click(screen.getByRole("button", { name: "调用 Skill" }));

    expect(screen.getByText("暂无已安装 Skill")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往技能管理" })).toHaveAttribute("href", "/agents/skills");
  });

  it("shows a retry action after load failure", async () => {
    const user = userEvent.setup();
    const { onRetry } = renderPicker({
      loadState: { status: "error", slugs: [], error: "network failed" },
    });

    await user.click(screen.getByRole("button", { name: "调用 Skill" }));
    expect(screen.getByText("Skill 列表加载失败")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("preserves and marks an installed binding that is now unavailable", async () => {
    const user = userEvent.setup();
    renderPicker({ value: "removed-skill", loadState: ready(["finance-news"]) });

    expect(screen.getByRole("button", { name: "调用 Skill" })).toHaveTextContent("Removed Skill");
    expect(screen.getByText("不可用")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "调用 Skill" }));
    expect(screen.getByRole("option", { name: /Removed Skill.*不可用/ })).toBeInTheDocument();
  });

  it("warns that Cron runs without interaction", () => {
    renderPicker();

    expect(screen.getByText("自动任务在非交互环境中运行，请确认该 Skill 支持无人值守执行")).toBeInTheDocument();
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
