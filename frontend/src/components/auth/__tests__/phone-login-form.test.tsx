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

  it("shows field validation before the caller gate blocks modal actions", () => {
    const beforeAction = vi.fn(() => false);
    render(<PhoneLoginForm variant="modal" beforeAction={beforeAction} />);

    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    expect(screen.getByText("请输入正确的中国大陆手机号。")).toBeInTheDocument();
    expect(screen.getByLabelText("手机号")).toHaveAttribute("aria-invalid", "true");
    expect(beforeAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "15625128341" } });
    fireEvent.change(screen.getByLabelText("短信验证码"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(screen.getByText("请输入正确的短信验证码。")).toBeInTheDocument();
    expect(screen.getByLabelText("短信验证码")).toHaveAttribute("aria-invalid", "true");
    expect(beforeAction).not.toHaveBeenCalled();
  });

  it("uses compact modal styling without the default oversized field radius", () => {
    render(<PhoneLoginForm variant="modal" />);

    const phoneInput = screen.getByLabelText("手机号");
    const codeInput = screen.getByLabelText("短信验证码");
    const phoneLabel = phoneInput.parentElement?.querySelector("label");
    const codeField = codeInput.parentElement?.parentElement;
    const codeLabel = codeField?.querySelector("label");

    expect(phoneInput).toHaveClass("rounded-md", "border-black/[0.08]", "font-normal");
    expect(codeInput).toHaveClass("rounded-md", "border-black/[0.08]", "font-normal");
    expect(phoneInput.parentElement).toHaveClass("block");
    expect(codeField).toHaveClass("block");
    expect(phoneLabel).toHaveClass("sr-only");
    expect(codeLabel).toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "获取验证码" })).toHaveClass("rounded-md", "border-black/[0.08]");
    expect(screen.getByRole("button", { name: "登录" })).toHaveClass("rounded-full", "shadow-none");
  });

  it("disables submit until phone and code are both filled", () => {
    render(<PhoneLoginForm variant="modal" />);

    const submitButton = screen.getByRole("button", { name: "登录" });
    expect(submitButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "15625128341" } });
    expect(submitButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("短信验证码"), { target: { value: "123456" } });
    expect(submitButton).not.toBeDisabled();
  });

  it("renders phone validation errors below the phone input with invalid styling", () => {
    render(<PhoneLoginForm variant="modal" />);

    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    const phoneInput = screen.getByLabelText("手机号");
    const phoneError = screen.getByText("请输入正确的中国大陆手机号。");
    expect(phoneInput).toHaveAttribute("aria-invalid", "true");
    expect(phoneInput).toHaveAttribute("aria-describedby", phoneError.id);
    expect(phoneInput).toHaveClass("!border-[color-mix(in_oklab,var(--danger)_60%,transparent)]");
    expect(phoneInput).toHaveStyle({ borderColor: "rgba(207, 61, 76, 0.6)" });
    expect(phoneInput.parentElement).toContainElement(phoneError);
  });

  it("renders code validation errors below the code input with invalid styling", () => {
    render(<PhoneLoginForm variant="modal" />);

    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "15625128341" } });
    fireEvent.change(screen.getByLabelText("短信验证码"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    const codeInput = screen.getByLabelText("短信验证码");
    const codeError = screen.getByText("请输入正确的短信验证码。");
    expect(codeInput).toHaveAttribute("aria-invalid", "true");
    expect(codeInput).toHaveAttribute("aria-describedby", codeError.id);
    expect(codeInput).toHaveClass("!border-[color-mix(in_oklab,var(--danger)_60%,transparent)]");
    expect(codeInput).toHaveStyle({ borderColor: "rgba(207, 61, 76, 0.6)" });
    expect(codeInput.parentElement?.parentElement).toContainElement(codeError);
  });
});
