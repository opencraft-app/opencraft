import {fireEvent, render} from "@testing-library/react-native";
import {Text} from "react-native";

import {velaTheme} from "../tokens";

describe("SystemSourceListRow", () => {
  it("exports one selected-row contract for resource and conversation lists", async () => {
    const {SystemSourceListRow} = require(
      "./system-source-list-row"
    ) as typeof import("./system-source-list-row");
    const onPress = jest.fn();
    const screen = await render(
      <SystemSourceListRow
        accessibilityLabel="打开 Agent research"
        badge="2"
        description="@research · 在线"
        kind="button"
        leading={<Text>研</Text>}
        onPress={onPress}
        rowId="agent-research"
        selected
        title="研究助手"
        trailing={<Text>16:03</Text>}
      />,
    );

    const row = screen.getByRole("button", {name: "打开 Agent research"});
    expect(row.props.accessibilityState).toEqual({disabled: false, selected: true});
    expect(row).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.selectionSurface,
      borderRadius: velaTheme.semantic.radius.compactControl,
      minHeight: velaTheme.recipes.control.rowHeight,
    });
    expect(screen.getByText("研究助手")).toBeVisible();
    expect(screen.getByText("@research · 在线")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    await fireEvent.press(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("uses current-page semantics for a selected navigation row", async () => {
    const {SystemSourceListRow} = require(
      "./system-source-list-row"
    ) as typeof import("./system-source-list-row");
    const screen = await render(
      <SystemSourceListRow
        accessibilityLabel="打开 Channel general"
        href="/servers/atlas/channels/general"
        kind="link"
        rowId="channel-general"
        selected
        title="general"
      />,
    );

    expect(screen.getByRole("link", {name: "打开 Channel general"}).props["aria-current"]).toBe(
      "page",
    );
  });
});
