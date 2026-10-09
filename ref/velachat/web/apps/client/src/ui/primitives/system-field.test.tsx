import {render} from "@testing-library/react-native";

import {velaTheme} from "../tokens";

describe("System field controls", () => {
  it("owns label, hint and validation semantics", async () => {
    const field = require("./system-field") as Record<string, unknown>;
    const SystemField = field.SystemField as undefined | React.ComponentType<any>;
    const SystemTextInput = field.SystemTextInput as undefined | React.ComponentType<any>;
    expect([SystemField, SystemTextInput]).not.toContain(undefined);
    if (!SystemField || !SystemTextInput) return;

    const screen = await render(
      <SystemField error="名称不能为空" hint="最多 100 个字符" label="名称">
        <SystemTextInput
          accessibilityLabel="名称"
          invalid
          onChangeText={() => undefined}
          testID="system-field-input"
          value=""
        />
      </SystemField>,
    );

    expect(screen.getByText("名称不能为空").props.accessibilityRole).toBe("alert");
    expect(screen.queryByText("最多 100 个字符")).toBeNull();
    expect(screen.getByTestId("system-field-input")).toHaveStyle({
      borderColor: velaTheme.semantic.color.borderDangerStrong,
      height: velaTheme.recipes.control.fieldHeight,
    });
  });

  it("provides large and multiline control geometry", async () => {
    const field = require("./system-field") as Record<string, unknown>;
    const SystemTextInput = field.SystemTextInput as undefined | React.ComponentType<any>;
    expect(SystemTextInput).toBeDefined();
    if (!SystemTextInput) return;

    const screen = await render(
      <>
        <SystemTextInput
          accessibilityLabel="邮箱"
          onChangeText={() => undefined}
          size="large"
          testID="large-field"
          value=""
        />
        <SystemTextInput
          accessibilityLabel="描述"
          multiline
          onChangeText={() => undefined}
          testID="multiline-field"
          value=""
        />
      </>,
    );

    expect(screen.getByTestId("large-field")).toHaveStyle({
      minHeight: velaTheme.recipes.authWorkspace.controlHeight,
    });
    expect(screen.getByTestId("multiline-field")).toHaveStyle({
      minHeight: velaTheme.recipes.managementWorkspace.textareaMinHeight,
    });
  });
});
