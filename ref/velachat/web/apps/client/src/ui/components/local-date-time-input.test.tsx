/** @jest-environment jsdom */

import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {readFileSync} from "node:fs";

import {LocalDateTimeInput} from "./local-date-time-input.web";

jest.mock("lucide-react-native/icons/calendar-days", () => () => null);
jest.mock("lucide-react-native/icons/chevron-left", () => () => null);
jest.mock("lucide-react-native/icons/chevron-right", () => () => null);
jest.mock("lucide-react-native/icons/clock-3", () => () => null);
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: () => ({fontScale: 1, height: 800, scale: 1, width: 1280}),
}));

describe("LocalDateTimeInput web", () => {
  it("routes the calendar overlay through the shared SystemPopover", () => {
    const source = readFileSync(
      require.resolve("./local-date-time-input.web"),
      "utf8",
    );

    expect(source).toContain("<SystemPopover");
    expect(source).not.toContain("<Popover");
  });

  it("renders a Vela trigger instead of the browser datetime-local control", async () => {
    const onChangeText = jest.fn();
    render(
      <LocalDateTimeInput
        accessibilityLabel="邀请有效期"
        onChangeText={onChangeText}
        value="2026-08-03T16:00"
      />,
    );
    const trigger = screen.getByLabelText("邀请有效期");

    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("type")).toBe("button");
    expect(screen.getByText("2026/08/03 16:00")).not.toBeNull();
  });

  it("keeps the trigger at the semantic field height", () => {
    render(
      <LocalDateTimeInput
        accessibilityLabel="邀请有效期"
        onChangeText={jest.fn()}
        value="2026-08-03T16:00"
      />,
    );

    const trigger = screen.getByLabelText("邀请有效期");
    expect(trigger.style.height).not.toBe("");
    expect(trigger.style.minHeight).toBe(trigger.style.height);
    expect(trigger.style.maxHeight).toBe(trigger.style.height);
  });

  it("keeps React Aria desktop popover positioning", () => {
    render(
      <LocalDateTimeInput
        accessibilityLabel="邀请有效期"
        onChangeText={jest.fn()}
        value="2026-08-03T16:00"
      />,
    );

    fireEvent.click(screen.getByLabelText("邀请有效期"));

    const popover = screen.getByRole("dialog").closest<HTMLElement>(
      ".react-aria-Popover",
    );
    expect(popover).not.toBeNull();
    expect(popover?.style.position).toBe("absolute");
  });

  it("converts native typography metrics before rendering picker controls", () => {
    render(
      <LocalDateTimeInput
        accessibilityLabel="邀请有效期"
        onChangeText={jest.fn()}
        presets={[{id: "24-hours", label: "24 小时", value: "2026-08-04T16:00"}]}
        value="2026-08-03T16:00"
      />,
    );

    fireEvent.click(screen.getByLabelText("邀请有效期"));

    const preset = screen.getByRole("button", {name: "24 小时"});
    expect(preset.style.height).not.toBe("");
    expect(preset.style.lineHeight.endsWith("px")).toBe(true);
  });

  it("preserves the management field error border at rest", () => {
    render(
      <LocalDateTimeInput
        accessibilityLabel="邀请有效期"
        onChangeText={jest.fn()}
        style={{borderColor: "rgb(243, 18, 96)"}}
        value="2026-08-03T16:00"
      />,
    );

    expect(screen.getByLabelText("邀请有效期").style.borderColor).toBe(
      "rgb(243, 18, 96)",
    );
  });

  it("keeps preset changes as a draft until confirmation", async () => {
    const onChangeText = jest.fn();
    render(
      <LocalDateTimeInput
        accessibilityLabel="邀请有效期"
        maxValue="2026-09-02T16:00"
        minValue="2026-08-03T16:05"
        minuteStep={5}
        onChangeText={onChangeText}
        presets={[
          {id: "24-hours", label: "24 小时", value: "2026-08-04T16:00"},
          {id: "7-days", label: "7 天", value: "2026-08-10T16:00"},
        ]}
        timezone="Asia/Shanghai"
        value="2026-08-10T16:00"
      />,
    );

    fireEvent.click(screen.getByLabelText("邀请有效期"));
    fireEvent.click(screen.getByRole("button", {name: "24 小时"}));
    expect(onChangeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", {name: "确认"}));
    expect(onChangeText).toHaveBeenCalledWith("2026-08-04T16:00");
  });

  it("discards the draft when cancelled", async () => {
    const onChangeText = jest.fn();
    render(
      <LocalDateTimeInput
        accessibilityLabel="提醒时间"
        onChangeText={onChangeText}
        presets={[
          {id: "tomorrow", label: "明天", value: "2026-08-04T16:00"},
        ]}
        timezone="America/New_York"
        value="2026-08-03T16:00"
      />,
    );

    fireEvent.click(screen.getByLabelText("提醒时间"));
    fireEvent.click(screen.getByRole("button", {name: "明天"}));
    fireEvent.click(screen.getByText("取消"));

    expect(onChangeText).not.toHaveBeenCalled();
    expect(screen.getByText("2026/08/03 16:00")).not.toBeNull();
  });

  it("discards the draft on Escape and restores trigger focus", async () => {
    const onChangeText = jest.fn();
    render(
      <LocalDateTimeInput
        accessibilityLabel="邀请有效期"
        onChangeText={onChangeText}
        presets={[
          {id: "tomorrow", label: "明天", value: "2026-08-04T16:00"},
        ]}
        value="2026-08-03T16:00"
      />,
    );
    const trigger = screen.getByLabelText("邀请有效期");

    act(() => trigger.focus());
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", {name: "明天"}));
    fireEvent.keyDown(screen.getByRole("dialog"), {key: "Escape"});

    expect(onChangeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("does not render invite presets unless callers provide them", async () => {
    render(
      <LocalDateTimeInput
        accessibilityLabel="提醒时间"
        onChangeText={jest.fn()}
        timezone="Asia/Shanghai"
        value="2026-08-03T16:00"
      />,
    );

    fireEvent.click(screen.getByLabelText("提醒时间"));

    expect(screen.queryByRole("button", {name: "24 小时"})).toBeNull();
    expect(screen.getByText("Asia/Shanghai")).not.toBeNull();
  });
});
