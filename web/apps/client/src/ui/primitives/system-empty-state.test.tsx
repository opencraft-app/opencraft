import {fireEvent, render} from "@testing-library/react-native";
import Search from "lucide-react-native/icons/search";

import {velaTheme} from "../tokens";

describe("SystemEmptyState", () => {
  it("keeps list empties compact and gives actions shared button semantics", async () => {
    const {SystemEmptyState} = require(
      "./system-empty-state"
    ) as typeof import("./system-empty-state");
    const onClear = jest.fn();
    const screen = await render(
      <SystemEmptyState
        description="换个关键词试试。"
        icon={Search}
        kind="list"
        primaryAction={{
          label: "清除筛选",
          onPress: onClear,
          variant: "secondary",
        }}
        title="没有匹配结果"
      />,
    );

    expect(screen.getByTestId("system-empty-state")).toHaveStyle({
      alignItems: "flex-start",
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
    });
    expect(screen.getByTestId("system-empty-state-icon")).toHaveStyle({
      height: velaTheme.recipes.iconControl.compactSize,
      width: velaTheme.recipes.iconControl.compactSize,
    });
    await fireEvent.press(screen.getByRole("button", {name: "清除筛选"}));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("keeps onboarding and canvas hierarchy explicit", async () => {
    const {SystemEmptyState} = require(
      "./system-empty-state"
    ) as typeof import("./system-empty-state");
    const screen = await render(
      <>
        <SystemEmptyState
          description="创建第一个 Agent。"
          kind="onboarding"
          testID="onboarding-empty"
          title="开始协作"
        />
        <SystemEmptyState
          description="当前没有记录。"
          kind="canvas"
          testID="canvas-empty"
          title="暂无内容"
        />
      </>,
    );

    expect(screen.getByTestId("onboarding-empty")).toHaveStyle({
      minHeight: velaTheme.recipes.emptyState.stageMinHeight,
    });
    expect(screen.getByTestId("canvas-empty")).not.toHaveStyle({
      minHeight: velaTheme.recipes.emptyState.stageMinHeight,
    });
  });
});
