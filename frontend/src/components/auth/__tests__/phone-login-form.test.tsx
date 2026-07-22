import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneLoginForm } from "@/components/auth/phone-login-form";

const sendSmsCode = vi.fn();
const signInWithCode = vi.fn();

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({ auth: { sendSmsCode } }),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({ signInWithCode }),
}));

describe("PhoneLoginForm", () => {
  beforeEach(() => {
    sendSmsCode.mockReset().mockResolvedValue({ cooldownSeconds: 60 });
    signInWithCode.mockReset().mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("sends a verification code to a valid mainland phone", async () => {
    render(<PhoneLoginForm />);

    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "15625128341" } });
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    await waitFor(() => expect(sendSmsCode).toHaveBeenCalledWith({ phone: "15625128341" }));
    expect(screen.getByRole("button", { name: "60s" })).toBeDisabled();
  });

  it("rejects an invalid phone before sending", () => {
    render(<PhoneLoginForm />);

    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    expect(screen.getByRole("alert")).toHaveTextContent("请输入正确的中国大陆手机号。");
    expect(sendSmsCode).not.toHaveBeenCalled();
  });

  it("submits phone and code through the session login flow", async () => {
    const onSignedIn = vi.fn();
    render(<PhoneLoginForm onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "15625128341" } });
    fireEvent.change(screen.getByLabelText("短信验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(signInWithCode).toHaveBeenCalledWith({ phone: "15625128341", code: "123456" }));
    expect(onSignedIn).toHaveBeenCalledOnce();
  });

  it("honors the caller gate before sending or submitting", () => {
    const beforeAction = vi.fn(() => false);
    render(<PhoneLoginForm beforeAction={beforeAction} />);

    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "15625128341" } });
    fireEvent.change(screen.getByLabelText("短信验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(beforeAction).toHaveBeenCalledTimes(2);
    expect(sendSmsCode).not.toHaveBeenCalled();
    expect(signInWithCode).not.toHaveBeenCalled();
  });
});
