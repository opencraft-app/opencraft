import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import {
  AccountSecurityCard,
  type AccountSecurityCardProps,
} from "@/components/account/account-security-card";

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

const buildProps = (
  overrides: Partial<AccountSecurityCardProps> = {},
): AccountSecurityCardProps => ({
  email: undefined,
  emailVerified: false,
  phone: undefined,
  showEmailBindSection: true,
  showSafetyPhoneSection: true,
  showRealnameSection: true,
  verified: false,
  realnameStatusLabel: "",
  phoneProofEnabled: false,
  faceIdFlowEnabled: false,
  idCardVerified: false,
  realnameSyncNeedsRetry: false,
  realnameSyncRetrying: false,
  idCardSyncStatus: undefined,
  emailBindSuccess: null,
  emailBindError: null,
  realnameSyncError: null,
  onBindEmail: vi.fn(),
  onBindPhone: vi.fn(),
  onChangePhone: vi.fn(),
  onVerifyRealname: vi.fn(),
  onRetryRealnameSync: vi.fn(),
  ...overrides,
});

describe("AccountSecurityCard", () => {
  it.each([
    { label: "未认证", tone: "neutral", state: {} },
    { label: "已认证", tone: "success", state: { verified: true, realnameStatusLabel: "已认证" } },
    { label: "需重新完成认证", tone: "warning", state: { phoneProofEnabled: true, faceIdFlowEnabled: true, idCardVerified: true, realnameStatusLabel: "需重新完成认证" } },
    { label: "实名信息同步中", tone: "warning", state: { phoneProofEnabled: true, idCardVerified: true, idCardSyncStatus: "pending" as const, realnameStatusLabel: "实名信息同步中" } },
    { label: "实名信息同步失败", tone: "danger", state: { phoneProofEnabled: true, idCardVerified: true, idCardSyncStatus: "failed" as const, realnameStatusLabel: "实名信息同步失败" } },
  ])("renders $label with the same compact badge structure as email verification", ({ label, tone, state }) => {
    const { container } = render(<AccountSecurityCard {...buildProps({
      email: "person@example.com",
      emailVerified: true,
      ...state,
    })} />);

    const badge = screen.getByText(label);
    const emailBadge = screen.getByText("已验证");
    expect(badge).toHaveAttribute("data-tone", tone);
    expect(badge.tagName).toBe(emailBadge.tagName);
    expect(badge).toHaveClass("inline-flex", "rounded-full", "px-2", "py-0.5", "text-xs", "font-semibold");
    expect(container.querySelector(".lucide-shield-check")).not.toBeInTheDocument();
  });

  it("renders translated account security copy for an English locale", async () => {
    await i18n.changeLanguage("en-US");

    render(<AccountSecurityCard {...buildProps()} />);

    expect(screen.getByRole("heading", { name: "Security" })).toBeVisible();
    expect(screen.queryByText("安全")).not.toBeInTheDocument();
  });

  it("delegates email, phone and first-time realname actions", async () => {
    const onBindEmail = vi.fn();
    const onBindPhone = vi.fn();
    const onVerifyRealname = vi.fn();

    render(
      <AccountSecurityCard
        {...buildProps({ onBindEmail, onBindPhone, onVerifyRealname })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "去绑定 邮箱" }));
    await userEvent.click(screen.getByRole("button", { name: "绑定 手机号" }));
    await userEvent.click(screen.getByRole("button", { name: "去认证" }));

    expect(onBindEmail).toHaveBeenCalledTimes(1);
    expect(onBindPhone).toHaveBeenCalledTimes(1);
    expect(onVerifyRealname).toHaveBeenCalledTimes(1);
  });

  it("shows verified values and delegates change actions", async () => {
    const onChangePhone = vi.fn();
    const onVerifyRealname = vi.fn();

    render(
      <AccountSecurityCard
        {...buildProps({
          email: "person@example.com",
          emailVerified: true,
          phone: "13800138000",
          verified: true,
          realnameStatusLabel: "已认证",
          onChangePhone,
          onVerifyRealname,
        })}
      />,
    );

    expect(screen.getByText("person@example.com")).toBeVisible();
    expect(screen.getByText("已验证")).toBeVisible();
    expect(screen.getByText("13800138000")).toBeVisible();
    expect(screen.getByText("已认证")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "修改 手机号" }));
    await userEvent.click(screen.getByRole("button", { name: "修改实名认证" }));

    expect(onChangePhone).toHaveBeenCalledTimes(1);
    expect(onVerifyRealname).toHaveBeenCalledTimes(1);
  });

  it("uses continue authentication after id-card verification", async () => {
    const onVerifyRealname = vi.fn();

    render(
      <AccountSecurityCard
        {...buildProps({
          phone: "13800138000",
          phoneProofEnabled: true,
          idCardVerified: true,
          realnameStatusLabel: "需重新完成认证",
          onVerifyRealname,
        })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "继续认证" }));
    expect(onVerifyRealname).toHaveBeenCalledTimes(1);
  });

  it("delegates realname synchronization retry and shows nearby feedback", async () => {
    const onRetryRealnameSync = vi.fn();

    render(
      <AccountSecurityCard
        {...buildProps({
          realnameStatusLabel: "实名信息同步失败",
          realnameSyncNeedsRetry: true,
          phoneProofEnabled: true,
          idCardSyncStatus: "failed",
          realnameSyncError: "同步服务繁忙",
          emailBindSuccess: "邮箱绑定成功。",
          emailBindError: "绑定链接已过期。",
          onRetryRealnameSync,
        })}
      />,
    );

    expect(screen.getByText("邮箱绑定成功。")).toHaveAttribute("role", "status");
    expect(screen.getByText("绑定链接已过期。")).toHaveAttribute("role", "alert");
    expect(screen.getByText("同步服务繁忙")).toHaveAttribute("role", "alert");

    await userEvent.click(screen.getByRole("button", { name: "重新同步" }));
    expect(onRetryRealnameSync).toHaveBeenCalledTimes(1);
  });
});
