import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PhoneCodeFields } from "@/pages/auth/phone-code-fields";

describe("PhoneCodeFields", () => {
  it("renders the send-code action alongside the phone input", () => {
    render(
      <PhoneCodeFields
        phone="13800138000"
        code=""
        sending={false}
        cooldownLeft={0}
        onPhoneChange={vi.fn()}
        onCodeChange={vi.fn()}
        onSendCode={vi.fn()}
      />,
    );

    const phoneInput = screen.getByLabelText("手机号");
    const phoneRow = phoneInput.parentElement;

    expect(phoneRow).not.toBeNull();
    expect(within(phoneRow as HTMLElement).getByRole("button", { name: "发送验证码" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "发送验证码" })).toHaveLength(1);
  });
});
