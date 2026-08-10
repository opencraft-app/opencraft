import {fireEvent, render} from "@testing-library/react-native";
import {existsSync} from "node:fs";
import {join} from "node:path";
import RefreshCw from "lucide-react-native/icons/refresh-cw";

import {velaTheme} from "../tokens";
import {ActionButton} from "./action-button";

const buttonModulePath = join(__dirname, "system-button.tsx");
const segmentedModulePath = join(__dirname, "system-segmented-control.tsx");

describe("Tahoe system controls", () => {
  it("exports the system controls from the public UI boundary", () => {
    const ui = require("../index") as Record<string, unknown>;
    expect([
      ui.SystemButton,
      ui.SystemIconButton,
      ui.SystemSegmentedControl,
    ]).not.toContain(undefined);
  });

  it("provides shared button and segmented-control modules", () => {
    expect(existsSync(buttonModulePath)).toBe(true);
    expect(existsSync(segmentedModulePath)).toBe(true);
  });

  it("gives labelled and icon actions distinct semantic variants", async () => {
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
          testID="default-button"
          variant="default"
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

    expect(screen.getByTestId("default-button").props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    expect(screen.getByTestId("default-button")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.actionPrimarySurface,
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
    await fireEvent.press(screen.getByTestId("default-button"));
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

  it("maps legacy actions onto location-aware system variants", async () => {
    const screen = await render(
      <>
        <ActionButton
          context="header"
          importance="tonal"
          label="新建"
          onPress={() => undefined}
          testID="legacy-toolbar"
        />
        <ActionButton
          importance="primary"
          label="保存"
          onPress={() => undefined}
          testID="legacy-default"
        />
      </>,
    );

    expect(screen.getByTestId("legacy-toolbar")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
      height: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(screen.getByTestId("legacy-default")).toHaveStyle({
      height: velaTheme.recipes.control.height,
    });
  });
});
