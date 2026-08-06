import { fireEvent, render } from "@testing-library/react-native";

import { velaTheme } from "@/ui";

import { AuthScreen } from "./auth-screen";

describe("AuthScreen", () => {
  it("keeps the compact login focused without exposing its cloud provider", async () => {
    const screen = await render(
      <AuthScreen mode="login" onSubmit={jest.fn()} />,
    );

    expect(screen.getByText("欢迎回来")).toBeVisible();
    expect(screen.queryByTestId("auth-account-icon")).toBeNull();
    expect(screen.getByTestId("auth-form-panel")).toHaveStyle({
      backgroundColor: "#FFFFFF",
      borderRadius: 16,
    });
    expect(screen.getByTestId("auth-email-input")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.fieldSurface,
      borderRadius: 10,
    });
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/腾讯云|TAT|Region/u);
  });

  it("submits the trimmed login credentials", async () => {
    const onSubmit = jest.fn();
    const screen = await render(
      <AuthScreen mode="login" onSubmit={onSubmit} />,
    );

    await fireEvent.changeText(
      screen.getByPlaceholderText("name@example.com"),
      "  human@example.test  ",
    );
    await fireEvent.changeText(
      screen.getByPlaceholderText("至少 8 位密码"),
      "correct horse battery staple",
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "登录" }),
    );

    expect(onSubmit).toHaveBeenCalledWith({
      email: "human@example.test",
      password: "correct horse battery staple",
    });
  });

  it("keeps invalid login fields on the client and explains each error", async () => {
    const onSubmit = jest.fn();
    const screen = await render(
      <AuthScreen mode="login" onSubmit={onSubmit} />,
    );

    await fireEvent.changeText(
      screen.getByPlaceholderText("name@example.com"),
      "a",
    );
    await fireEvent.changeText(
      screen.getByPlaceholderText("至少 8 位密码"),
      "1",
    );
    await fireEvent.press(screen.getByRole("button", {name: "登录"}));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("请输入有效的邮箱地址。")).toBeVisible();
    expect(screen.getByText("密码至少需要 8 位。")).toBeVisible();
  });

  it("clears the previous auth error before switching mode", async () => {
    const onDismissError = jest.fn();
    const onModeChange = jest.fn();
    const screen = await render(
      <AuthScreen
        error="请求参数无效"
        mode="login"
        onDismissError={onDismissError}
        onModeChange={onModeChange}
        onSubmit={jest.fn()}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "还没有账号？立即注册"}),
    );

    expect(onDismissError).toHaveBeenCalledTimes(1);
    expect(onModeChange).toHaveBeenCalledWith("register");
  });

  it("requires a display name before registering", async () => {
    const onSubmit = jest.fn();
    const screen = await render(
      <AuthScreen mode="register" onSubmit={onSubmit} />,
    );

    await fireEvent.changeText(
      screen.getByPlaceholderText("name@example.com"),
      "human@example.test",
    );
    await fireEvent.changeText(
      screen.getByPlaceholderText("至少 8 位密码"),
      "password-123",
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "注册并继续"}),
    );

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("请输入显示名称。")).toBeVisible();
  });
});
