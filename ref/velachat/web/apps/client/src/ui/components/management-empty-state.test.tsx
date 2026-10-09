import {fireEvent, render} from "@testing-library/react-native";

import {velaTheme} from "../tokens";
import {ManagementEmptyState} from "./management-empty-state";

describe("ManagementEmptyState", () => {
  it("renders zero data as a preference row with a secondary action", async () => {
    const onAction = jest.fn();
    const screen = await render(
      <ManagementEmptyState
        actionAccessibilityLabel="从空状态新建任务"
        actionLabel="新建任务"
        description="任务会出现在这里，也可以从 Agent 对话生成。"
        onAction={onAction}
        title="还没有任务"
      />,
    );

    expect(screen.getByTestId("management-empty-state-row")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.sectionSurface,
      borderColor: velaTheme.semantic.color.separator,
      flexDirection: "row",
    });
    expect(screen.getByTestId("management-empty-state-action")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.actionSecondarySurface,
      borderColor: velaTheme.semantic.color.borderControl,
    });
    expect(screen.queryByTestId("management-empty-state-icon")).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {name: "从空状态新建任务"}),
    );
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("keeps read-only empty states as compact copy without an action", async () => {
    const screen = await render(
      <ManagementEmptyState
        description="请联系 Server Owner 或 Admin 创建。"
        title="还没有可用 Agent"
      />,
    );

    expect(screen.getByText("还没有可用 Agent")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
