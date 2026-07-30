import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScenarioQuickPromptEditor } from "../ScenarioQuickPromptEditor";
import {
  formatScenarioQuickPrompt,
  formatScenarioQuickPromptSegments,
  getScenarioTaskPack,
} from "../scenario-packs";

afterEach(() => {
  cleanup();
});

describe("ScenarioQuickPromptEditor", () => {
  it("uses one editable conversation field for the whole task", () => {
    const pack = getScenarioTaskPack("stock-info-digest");
    const values = Object.fromEntries(pack.fields.map((field) => [field.key, field.defaultValue]));
    const value = formatScenarioQuickPrompt(pack, values);
    const onChange = vi.fn();

    const { container } = render(
      <ScenarioQuickPromptEditor
        value={value}
        suggestedSegments={formatScenarioQuickPromptSegments(pack, values)}
        onChange={onChange}
      />,
    );

    const editor = screen.getByLabelText("任务内容");
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor).toHaveValue(value);
    expect(container.querySelectorAll("textarea")).toHaveLength(1);
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("input")).toBeNull();

    fireEvent.change(editor, {
      target: { value: `${value} 另外关注港交所公告。` },
    });
    expect(onChange).toHaveBeenCalledWith(`${value} 另外关注港交所公告。`);
  });

  it("keeps template language black and suggested values red", () => {
    const pack = getScenarioTaskPack("rent-reminder");
    const values = Object.fromEntries(pack.fields.map((field) => [field.key, field.defaultValue]));
    const value = formatScenarioQuickPrompt(pack, values);

    const { container } = render(
      <ScenarioQuickPromptEditor
        value={value}
        suggestedSegments={formatScenarioQuickPromptSegments(pack, values)}
        onChange={vi.fn()}
      />,
    );

    expect(container.querySelectorAll("[data-suggested='false']").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-suggested='true']").length).toBeGreaterThan(0);
    expect(container.querySelector("[data-suggested='false']")).toHaveClass("text-black/72");
    expect(container.querySelector("[data-suggested='true']")).toHaveClass("text-[#A33A3A]");
  });

  it("renders notification controls in the same composer", () => {
    render(
      <ScenarioQuickPromptEditor
        value="请每天提醒我。"
        suggestedSegments={[
          { text: "请每天", suggested: false },
          { text: "提醒我", suggested: true },
          { text: "。", suggested: false },
        ]}
        onChange={vi.fn()}
        footer={<button type="button">企业微信</button>}
      />,
    );

    expect(screen.getByTestId("scenario-task-composer")).toContainElement(
      screen.getByRole("button", { name: "企业微信" }),
    );
  });

  it("uses optional wording for body data", () => {
    const pack = getScenarioTaskPack("calorie-fitness-checkin");
    const values = Object.fromEntries(pack.fields.map((field) => [field.key, field.defaultValue]));
    const value = formatScenarioQuickPrompt(pack, values);

    expect(value).toContain("身体数据（可选）");
    expect(value).not.toContain("身体数据（自愿）");
    expect(value).not.toContain("反馈轻一点");
  });
});
