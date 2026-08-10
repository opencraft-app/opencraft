import {fireEvent, render} from "@testing-library/react-native";

import {velaTheme} from "../tokens";

describe("SystemFeedback", () => {
  it("presents product copy and keeps technical detail collapsed", async () => {
    const {SystemFeedback} = require(
      "./system-feedback"
    ) as typeof import("./system-feedback");
    const screen = await render(
      <SystemFeedback
        error={{
          code: "method_not_allowed",
          detail: "平台返回了未预期的 HTTP 405",
          scope: "invite.create",
        }}
        kind="inline"
      />,
    );

    expect(screen.getByText("当前服务版本暂不支持此操作")).toBeVisible();
    expect(screen.getByText("刷新页面；仍失败则联系管理员")).toBeVisible();
    expect(screen.queryByText(/HTTP 405/u)).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", {name: "查看技术详情"}),
    );
    expect(screen.getByText("平台返回了未预期的 HTTP 405")).toBeVisible();
  });

  it("distinguishes blocking feedback from polite inline feedback", async () => {
    const {SystemFeedback} = require(
      "./system-feedback"
    ) as typeof import("./system-feedback");
    const screen = await render(
      <>
        <SystemFeedback kind="inline" message="设置已保存" testID="inline" />
        <SystemFeedback kind="blocking" message="连接已中断" testID="blocking" />
      </>,
    );

    expect(screen.getByTestId("inline").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.getByTestId("blocking").props.accessibilityRole).toBe("alert");
    expect(screen.getByTestId("blocking")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.statusDangerSurface,
    });
  });
});
