import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CronJob } from "@/lib/hermes-cron-client";
import { AutomationUpstreamPicker } from "../automation-upstream-picker";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AutomationUpstreamPicker", () => {
  it("filters candidates by name and selects the matching upstream", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AutomationUpstreamPicker
        value=""
        options={[
          makeCronJob({ id: "a", name: "每日新闻收集" }),
          makeCronJob({ id: "b", name: "天气提醒" }),
        ]}
        state="supported"
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "上游任务" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const searchCombobox = screen.getByRole("combobox", { name: "搜索上游任务" });
    expect(searchCombobox).toHaveFocus();
    expect(searchCombobox).toHaveAttribute("aria-expanded", "true");
    expect(searchCombobox).toHaveAttribute("aria-autocomplete", "list");
    expect(searchCombobox).toHaveAttribute("aria-controls");
    await user.type(searchCombobox, "新闻");

    expect(screen.getByRole("option", { name: /每日新闻收集/ })).toBeInTheDocument();
    expect(screen.queryByText("天气提醒")).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /每日新闻收集/ }));
    expect(onChange).toHaveBeenCalledWith("a");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("only shows the task name in the option list", async () => {
    const user = userEvent.setup();
    render(
      <AutomationUpstreamPicker
        value=""
        options={[
          makeCronJob({
            id: "a",
            name: "每日新闻收集",
            schedule: { kind: "cron", expr: "35 20 * * *", display: "35 20 * * *" },
            last_run_at: "2026-08-17 20:35",
          }),
        ]}
        state="supported"
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "上游任务" }));

    const option = screen.getByRole("option", { name: /每日新闻收集/ });
    expect(option).not.toHaveTextContent("35 20 * * *");
    expect(option).not.toHaveTextContent("最近完成");
    expect(option).not.toHaveTextContent("2026-08-17 20:35");
  });

  it("removes the no-upstream option and clears the selection from the trigger action", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AutomationUpstreamPicker
        value="a"
        options={[makeCronJob({ id: "a", name: "每日新闻收集" })]}
        state="supported"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "上游任务" }));
    expect(screen.queryByRole("option", { name: "不关联" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消选择" }));

    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.getByRole("combobox", { name: "上游任务" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("turns the selected option check into a clear action on hover", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AutomationUpstreamPicker
        value="a"
        options={[makeCronJob({ id: "a", name: "每日新闻收集" })]}
        state="supported"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "上游任务" }));
    const selectedOption = screen.getByRole("option", { name: /每日新闻收集/ });

    expect(selectedOption.querySelector(".lucide-check")).toHaveClass("opacity-100");
    expect(selectedOption.querySelector(".lucide-x")).toHaveClass("opacity-0");

    await user.hover(selectedOption);

    expect(selectedOption.querySelector(".lucide-check")).toHaveClass("opacity-0");
    expect(selectedOption.querySelector(".lucide-x")).toHaveClass("opacity-100");

    await user.unhover(selectedOption);

    expect(selectedOption.querySelector(".lucide-check")).toHaveClass("opacity-100");
    expect(selectedOption.querySelector(".lucide-x")).toHaveClass("opacity-0");

    await user.hover(selectedOption);
    await user.click(selectedOption);

    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps a missing selected upstream actionable so the relationship can be cleared", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AutomationUpstreamPicker
        value="deleted-upstream"
        options={[]}
        state="supported"
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("combobox", { name: "上游任务" })).toHaveTextContent("上游任务已不可用");
    await user.click(screen.getByRole("button", { name: "取消选择" }));

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("shows loading, unsupported and unknown states with a retry action", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(
      <AutomationUpstreamPicker
        value=""
        options={[]}
        state="loading"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("正在检测上游任务能力...")).toBeInTheDocument();

    rerender(
      <AutomationUpstreamPicker
        value=""
        options={[]}
        state="unsupported"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("当前 Hermes 版本不支持上游任务，请升级后重试。")).toBeInTheDocument();

    rerender(
      <AutomationUpstreamPicker
        value=""
        options={[]}
        state="unknown"
        onChange={vi.fn()}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("暂时无法确认 Hermes 是否支持上游任务。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();

  });

  it("keeps the empty picker openable and explains its context behavior in the trigger", async () => {
    const user = userEvent.setup();
    render(
      <AutomationUpstreamPicker
        value=""
        options={[]}
        state="supported"
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "上游任务" });
    expect(trigger).toHaveTextContent("本任务执行时，将使用上游任务最近的输出作为上下文");
    expect(trigger).not.toHaveTextContent("使用上游任务最近一次的输出来作为本任务执行的上下文");

    await user.click(trigger);

    expect(screen.getByText("暂无可关联的上游任务")).toBeInTheDocument();
  });

  it("warns when the existing job has multiple upstreams", () => {
    render(
      <AutomationUpstreamPicker
        value=""
        options={[]}
        state="supported"
        existingMultipleUpstreams={[
          makeCronJob({ id: "a", name: "新闻收集" }),
          makeCronJob({ id: "b", name: "市场摘要" }),
        ]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("当前任务配置了多个上游，暂不支持在 LightVela 中编辑")).toBeInTheDocument();
    expect(screen.getByText("新闻收集、市场摘要")).toBeInTheDocument();
  });

  it("supports Enter, ArrowDown and Escape with complete combobox state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AutomationUpstreamPicker
        value=""
        options={[makeCronJob({ id: "a", name: "每日新闻收集" })]}
        state="supported"
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "上游任务" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const searchbox = screen.getByRole("combobox", { name: "搜索上游任务" });
    expect(searchbox).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("a");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes when clicking outside", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <AutomationUpstreamPicker
          value=""
          options={[makeCronJob({ id: "a" })]}
          state="supported"
          onChange={vi.fn()}
        />
        <button type="button">弹窗空白区域</button>
      </div>,
    );

    const trigger = screen.getByRole("combobox", { name: "上游任务" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "弹窗空白区域" }));

    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

function makeCronJob(overrides: Partial<CronJob>): CronJob {
  return {
    id: "job-1",
    name: "提醒",
    prompt: "提醒我喝水",
    schedule: { kind: "cron", expr: "0 9 * * *", display: "每天 09:00" },
    skills: [],
    enabled: true,
    state: "",
    deliver: "local",
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    created_at: null,
    script: "",
    effective_window: null,
    lightvela_schedule: null,
    context_from: null,
    inference_config: null,
    ...overrides,
  };
}
