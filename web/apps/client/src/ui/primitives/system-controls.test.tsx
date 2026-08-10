import {fireEvent, render} from "@testing-library/react-native";
import {existsSync} from "node:fs";
import {join} from "node:path";
import RefreshCw from "lucide-react-native/icons/refresh-cw";

import {velaTheme} from "../tokens";

const buttonModulePath = join(__dirname, "system-button.tsx");
const segmentedModulePath = join(__dirname, "system-segmented-control.tsx");
const tabsModulePath = join(__dirname, "system-tabs.tsx");

describe("Tahoe system controls", () => {
  it("exports the system controls from the public UI boundary", () => {
    const ui = require("../index") as Record<string, unknown>;
    expect([
      ui.SystemButton,
      ui.SystemIconButton,
      ui.SystemSegmentedControl,
      ui.SystemTabs,
    ]).not.toContain(undefined);
  });

  it("provides shared button and segmented-control modules", () => {
    expect(existsSync(buttonModulePath)).toBe(true);
    expect(existsSync(segmentedModulePath)).toBe(true);
    expect(existsSync(tabsModulePath)).toBe(true);
  });

  it("makes the ordinary labelled action neutral by construction", async () => {
    if (!existsSync(buttonModulePath)) return;
    const {
      SystemButton,
      SystemIconButton,
    } = require("./system-button") as typeof import("./system-button");
    const onPress = jest.fn();
    const screen = await render(
      <>
        <SystemButton
          busy
          label="保存"
          onPress={onPress}
          testID="standard-button"
          variant="standard"
        />
        <SystemButton
          label="新建"
          onPress={onPress}
          testID="toolbar-button"
          variant="toolbar"
        />
        <SystemIconButton
          accessibilityLabel="刷新"
          icon={RefreshCw}
          onPress={onPress}
          testID="icon-button"
          variant="toolbar"
        />
      </>,
    );

    expect(screen.getByTestId("standard-button").props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    expect(screen.getByTestId("standard-button")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.actionSecondarySurface,
      borderColor: velaTheme.semantic.color.borderControl,
      height: velaTheme.recipes.control.height,
    });
    expect(screen.getByTestId("toolbar-button")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
      height: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(screen.getByTestId("icon-button")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
      height: velaTheme.recipes.managementWorkspace.headerActionHeight,
      width: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    await fireEvent.press(screen.getByTestId("standard-button"));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("renders one continuous radiogroup and changes selection from keyboard", async () => {
    if (!existsSync(segmentedModulePath)) return;
    const {SystemSegmentedControl} = require(
      "./system-segmented-control"
    ) as typeof import("./system-segmented-control");
    const onChange = jest.fn();
    const screen = await render(
      <SystemSegmentedControl
        accessibilityLabel="回复策略"
        onChange={onChange}
        options={[
          {label: "自动回复", value: "auto"},
          {label: "仅提及", value: "mention"},
          {disabled: true, label: "关闭", value: "off"},
        ]}
        testID="reply-policy"
        value="auto"
      />,
    );

    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAccessibleName("回复策略");
    expect(group).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.fieldSurfaceRecessed,
      borderRadius: velaTheme.semantic.radius.compactControl,
      flexDirection: "row",
    });
    expect(screen.getByRole("radio", {name: "自动回复"}).props.accessibilityState).toEqual({
      checked: true,
      disabled: false,
    });
    expect(screen.getByRole("radio", {name: "仅提及"})).toHaveStyle({
      borderWidth: 0,
    });

    await fireEvent(screen.getByRole("radio", {name: "自动回复"}), "keyDown", {
      nativeEvent: {key: "ArrowRight"},
      preventDefault: jest.fn(),
    });
    expect(onChange).toHaveBeenCalledWith("mention");

    await fireEvent(screen.getByRole("radio", {name: "仅提及"}), "keyDown", {
      nativeEvent: {key: "ArrowRight"},
      preventDefault: jest.fn(),
    });
    expect(onChange).toHaveBeenLastCalledWith("auto");
  });

  it("renders toolbar tabs with roving keyboard selection", async () => {
    if (!existsSync(tabsModulePath)) return;
    const {SystemTabs} = require("./system-tabs") as typeof import("./system-tabs");
    const onChange = jest.fn();
    const screen = await render(
      <SystemTabs
        accessibilityLabel="任务视图"
        onChange={onChange}
        options={[
          {label: "任务", panelId: "tasks-panel", value: "tasks"},
          {label: "提醒", panelId: "reminders-panel", value: "reminders"},
        ]}
        testID="task-tabs"
        value="tasks"
      />,
    );

    expect(screen.getByRole("tablist")).toHaveAccessibleName("任务视图");
    expect(screen.getByTestId("task-tabs")).toHaveStyle({
      borderWidth: 0,
      height: velaTheme.recipes.control.height,
    });
    expect(screen.getByRole("tab", {name: "任务"}).props.accessibilityState).toEqual({
      disabled: false,
      selected: true,
    });
    expect(screen.getByRole("tab", {name: "任务"})).toHaveStyle({
      shadowColor: velaTheme.shadows.card.color,
    });
    expect(screen.getByRole("tab", {name: "任务"}).props["aria-controls"]).toBe("tasks-panel");
    await fireEvent(screen.getByRole("tab", {name: "任务"}), "keyDown", {
      nativeEvent: {key: "ArrowRight"},
      preventDefault: jest.fn(),
    });
    expect(onChange).toHaveBeenCalledWith("reminders");
  });
});
