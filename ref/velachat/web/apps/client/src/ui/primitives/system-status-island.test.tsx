import {act, fireEvent, render} from "@testing-library/react-native";
import {Text} from "react-native";

import {SystemStatusIsland} from "./system-status-island";

describe("SystemStatusIsland", () => {
  it("stays inline, starts collapsed and toggles renderer-neutral details", async () => {
    const screen = await render(
      <SystemStatusIsland
        details={<Text>后台步骤详情</Text>}
        summary="正在启动 Agent · 1/3"
        testID="status-island"
        tone="info"
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "正在启动 Agent · 1/3",
    });
    expect(trigger.props.accessibilityState).toEqual({expanded: false});
    expect(screen.getByTestId("status-island-summary").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByText("后台步骤详情")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    await fireEvent.press(trigger);
    expect(screen.getByRole("button", {
      name: "正在启动 Agent · 1/3",
    }).props.accessibilityState).toMatchObject({expanded: true});
    expect(screen.getByText("后台步骤详情")).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      screen.getByRole("button", {
        name: "正在启动 Agent · 1/3",
      }).props.onKeyDown({key: "Escape"});
    });
    expect(screen.queryByText("后台步骤详情")).toBeNull();
  });

  it("renders lifecycle-only feedback without fake disclosure", async () => {
    const screen = await render(
      <SystemStatusIsland
        summary="绑定的 Computer 当前不可用"
        testID="status-island"
        tone="warning"
      />,
    );

    expect(screen.getByText("绑定的 Computer 当前不可用")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("accepts a stage-owned top inset without learning conversation geometry", async () => {
    const screen = await render(
      <SystemStatusIsland
        summary="正在部署"
        testID="status-island"
        tone="info"
        topInset={72}
      />,
    );

    expect(screen.getByTestId("status-island")).toHaveStyle({top: 72});
  });
});
