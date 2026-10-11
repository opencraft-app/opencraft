import {fireEvent, render} from "@testing-library/react-native";

import {velaTheme} from "../tokens";

describe("System switch controls", () => {
  it("exposes native switch semantics and delegates state changes", async () => {
    const controls = require("./system-switch") as Record<string, unknown>;
    const SystemSwitch = controls.SystemSwitch as undefined | React.ComponentType<any>;
    expect(SystemSwitch).toBeDefined();
    if (!SystemSwitch) return;
    const onChange = jest.fn();

    const screen = await render(
      <SystemSwitch
        accessibilityLabel="部署并启动"
        checked
        onChange={onChange}
        testID="system-switch"
      />,
    );

    const control = screen.getByTestId("system-switch");
    expect(control.props.accessibilityRole).toBe("switch");
    expect(control.props.accessibilityState).toEqual({checked: true, disabled: false});
    expect(control).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.statusPositive,
    });
    fireEvent.press(control);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("owns the whole toggle row without duplicating interaction semantics", async () => {
    const controls = require("./system-switch") as Record<string, unknown>;
    const SystemToggleRow = controls.SystemToggleRow as undefined | React.ComponentType<any>;
    expect(SystemToggleRow).toBeDefined();
    if (!SystemToggleRow) return;
    const onChange = jest.fn();

    const screen = await render(
      <SystemToggleRow
        checked={false}
        description="创建后立即上线"
        label="部署并启动"
        onChange={onChange}
        testID="system-toggle-row"
      />,
    );

    const row = screen.getByTestId("system-toggle-row");
    expect(row.props.accessibilityRole).toBe("switch");
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    fireEvent.press(row);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
