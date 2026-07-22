import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass, User } from "@/domain/types";
import { AccountPage } from "@/pages/marketing/account-page";
import { RepositoryError } from "@/repositories/http-repositories";

const updateProfile = vi.fn();
const uploadAvatar = vi.fn();
const signOut = vi.fn();
const deleteAccount = vi.fn();
const signInAsGuest = vi.fn();
const refreshProfile = vi.fn();
const retryRealnameSync = vi.fn();
const startRealnameFaceIdAttempt = vi.fn();
const getRealnameFaceIdAttempt = vi.fn();
const getCurrentRealnameFaceIdAttempt = vi.fn();
const verifyRealnameFaceIdPhone = vi.fn();
const finalizeRealnameFaceIdAttempt = vi.fn();
const verifyRealnamePhone = vi.fn();
const sendRealnameFaceIdPhoneCode = vi.fn();
const sendSmsCode = vi.fn();

let currentUser: User;
let activePass: Pass | null = null;
let sessionAuthReady = true;
let sessionIsAuthenticated = true;
let realnamePhoneVerificationEnabled = true;
let renderTick = 0;
let rerenderPage: (() => void) | null = null;

const createMemoryStorage = (): Storage => {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => entries.set(key, value),
  };
};

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  usePaidBillingEnabled: () => false,
  useRealnamePhoneVerificationEnabled: () => realnamePhoneVerificationEnabled,
}));

vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "zh-CN",
  isCN: true,
  isGlobal: false,
}));

vi.mock("@/components/site/legal-footer", () => ({
  LegalFooter: () => <footer>legal footer</footer>,
}));

vi.mock("@/components/site/brand-mark", () => ({
  BrandMark: () => <a href="/">LightVela</a>,
}));

vi.mock("@/components/site/language-switcher", () => ({
  LanguageSwitcher: () => null,
}));

vi.mock("@/components/site/login-modal", () => ({
  LoginModal: () => null,
}));

vi.mock("@/components/site/user-avatar-menu", () => ({
  UserAvatarMenu: () => <div>avatar menu</div>,
}));

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({
    user: {
      plan: {
        name: "启航套餐",
        trialDays: 7,
      },
    },
    activePass,
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    auth: {
      startRealnameFaceIdAttempt,
      getRealnameFaceIdAttempt,
      getCurrentRealnameFaceIdAttempt,
      verifyRealnameFaceIdPhone,
      finalizeRealnameFaceIdAttempt,
      sendRealnameFaceIdPhoneCode,
      sendSmsCode,
      verifyRealnamePhone,
      retryRealnameSync,
    },
    plans: {
      listMyPasses: vi.fn().mockResolvedValue([]),
    },
  }),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => {
    renderTick;
    return {
      session: {
        user: sessionIsAuthenticated ? currentUser : null,
        currentSubscription: null,
      },
      isAuthenticated: sessionIsAuthenticated,
      authReady: sessionAuthReady,
      signInAsGuest,
      updateProfile,
      uploadAvatar,
      refreshProfile,
      signOut,
      deleteAccount,
    };
  },
}));

const renderAccountPage = (revealFaceIdFlow = true) => {
  const rendered = render(
    <MemoryRouter>
      <AccountPage />
    </MemoryRouter>,
  );
  rerenderPage = () => {
    renderTick += 1;
    rendered.rerender(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );
  };
  if (revealFaceIdFlow) {
    act(() => {
      (window as Window & { show?: () => boolean }).show?.();
    });
  }
  return rendered;
};

const openVerifyModal = async () => {
  await userEvent.click(screen.getByRole("button", { name: /去认证/ }));
  expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
};

describe("AccountPage FaceID flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", createMemoryStorage());
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    currentUser = {
      id: "usr_faceid",
      name: "旧昵称",
      phone: "15625128341",
      inviteRequired: false,
      realnameVerified: false,
      realnameAssuranceMode: "face_required",
      createdAt: "2026-06-01T00:00:00Z",
    };
    activePass = null;
    sessionAuthReady = true;
    sessionIsAuthenticated = true;
    realnamePhoneVerificationEnabled = true;
    renderTick = 0;
    rerenderPage = null;
    sendSmsCode.mockResolvedValue({ cooldownSeconds: 60 });
    sendRealnameFaceIdPhoneCode.mockResolvedValue({ cooldownSeconds: 60 });
    refreshProfile.mockResolvedValue(undefined);
    getCurrentRealnameFaceIdAttempt.mockRejectedValue(
      new RepositoryError("not found", 404, "realname_faceid_not_found"),
    );
    verifyRealnameFaceIdPhone.mockReset();
    finalizeRealnameFaceIdAttempt.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses FaceID immediately when the backend requires it", async () => {
    renderAccountPage(false);

    await userEvent.click(screen.getByRole("button", { name: /去认证/ }));

    expect(screen.getByRole("button", { name: "开始刷脸认证" })).toBeInTheDocument();
    expect(startRealnameFaceIdAttempt).not.toHaveBeenCalled();
  });

  it("exposes an accessible dialog and closes it with Escape", async () => {
    renderAccountPage();
    await openVerifyModal();

    expect(screen.getByRole("dialog", { name: "实名认证" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "证件类型" })).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "实名认证" })).not.toBeInTheDocument();
  });

  it("uses dedicated visible tokens for identity controls", async () => {
    renderAccountPage();
    await openVerifyModal();

    expect(screen.getByText("中国大陆居民身份证").parentElement).toHaveClass(
      "bg-[var(--realname-control-muted)]",
    );
    expect(screen.getByRole("textbox", { name: /真实姓名/ })).toHaveClass(
      "border-[var(--realname-control-border)]",
    );
    expect(screen.getByRole("textbox", { name: /身份证号/ })).toHaveClass(
      "border-[var(--realname-control-border)]",
    );
  });

  it("shows identity mismatch as field-linked guidance without exposing the error code", async () => {
    startRealnameFaceIdAttempt.mockRejectedValue(
      new RepositoryError(
        "姓名身份证号不一致。（realname_mismatch）",
        422,
        "realname_mismatch",
      ),
    );

    renderAccountPage();
    await openVerifyModal();

    expect(screen.getByTestId("realname-stage-content")).not.toHaveClass("min-h-[248px]");
    const nameInput = screen.getByRole("textbox", { name: /真实姓名/ });
    const idCardInput = screen.getByRole("textbox", { name: /身份证号/ });
    await userEvent.type(nameInput, "张三");
    await userEvent.type(idCardInput, "110101199001011234");
    const consentCheckbox = screen.getByRole("checkbox", { name: /我已阅读.*并同意/ });
    const feedbackArea = screen.getByTestId("realname-feedback-area");
    const submitButton = screen.getByRole("button", { name: "开始刷脸认证" });
    expect(feedbackArea).toHaveTextContent("你的姓名、身份证号和核身过程仅用于本次实名认证");
    expect(consentCheckbox.compareDocumentPosition(feedbackArea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(feedbackArea.compareDocumentPosition(submitButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(consentCheckbox);
    await userEvent.click(submitButton);

    const errorTitle = await screen.findByText("身份信息未通过核验");
    expect(screen.getByTestId("realname-feedback-area")).toBe(feedbackArea);
    expect(feedbackArea).toContainElement(errorTitle.closest('[role="alert"]'));
    expect(feedbackArea).not.toHaveTextContent("你的姓名、身份证号和核身过程仅用于本次实名认证");
    expect(screen.getByText("请确认姓名与身份证上的信息完全一致后重试。")).toBeInTheDocument();
    expect(screen.queryByText(/realname_mismatch/)).not.toBeInTheDocument();
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    expect(idCardInput).toHaveAttribute("aria-invalid", "true");
    expect(nameInput).toHaveAttribute("aria-describedby", "realname-identity-error");
    expect(idCardInput).toHaveAttribute("aria-describedby", "realname-identity-error");

    await userEvent.type(nameInput, "丰");
    expect(screen.queryByText("身份信息未通过核验")).not.toBeInTheDocument();
  });

  it("shows phone-in-use guidance in the stable bottom slot and clears it when the phone changes", async () => {
    currentUser = {
      ...currentUser,
      phone: undefined,
      realnameLevel: undefined,
      realnameVerified: false,
    };
    startRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_phone_in_use",
      verificationUrl: "https://faceid.example.invalid/attempt_phone_in_use",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });
    getRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_phone_in_use",
      state: "phone_pending",
    });
    verifyRealnameFaceIdPhone.mockRejectedValue(
      new RepositoryError(
        "该手机号已绑定其他 Lightvela 账号。（phone_in_use）",
        409,
        "phone_in_use",
      ),
    );

    renderAccountPage();
    await openVerifyModal();
    await userEvent.type(screen.getByRole("textbox", { name: /真实姓名/ }), "张三");
    await userEvent.type(screen.getByRole("textbox", { name: /身份证号/ }), "110101199001011234");
    await userEvent.click(screen.getByRole("checkbox", { name: /我已阅读.*并同意/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    const phoneInput = await screen.findByRole("textbox", { name: /手机号/ });
    expect(screen.getByTestId("realname-stage-content")).not.toHaveClass("min-h-[248px]");
    await userEvent.type(phoneInput, "17631219511");
    const smsCodeInput = screen.getByRole("textbox", { name: /短信验证码/ });
    await userEvent.type(smsCodeInput, "256987");
    const feedbackArea = screen.getByTestId("realname-feedback-area");
    const submitButton = screen.getByRole("button", { name: "完成手机号认证" });
    expect(feedbackArea).toHaveTextContent("你的姓名、身份证号和核身过程仅用于本次实名认证");
    expect(smsCodeInput.compareDocumentPosition(feedbackArea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(feedbackArea.compareDocumentPosition(submitButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(submitButton);

    const errorTitle = await screen.findByText("该手机号暂不可使用");
    expect(screen.getByTestId("realname-feedback-area")).toBe(feedbackArea);
    expect(feedbackArea).toContainElement(errorTitle.closest('[role="alert"]'));
    expect(feedbackArea).not.toHaveTextContent("你的姓名、身份证号和核身过程仅用于本次实名认证");
    expect(screen.getByText("该手机号已绑定其他 LightVela 账号，请更换手机号或联系管理员。")).toBeInTheDocument();
    expect(screen.queryByText(/phone_in_use/)).not.toBeInTheDocument();
    expect(phoneInput).toHaveAttribute("aria-invalid", "true");
    expect(phoneInput).toHaveAttribute("aria-describedby", "realname-phone-error");

    await userEvent.type(phoneInput, "2");
    expect(screen.queryByText("该手机号暂不可使用")).not.toBeInTheDocument();
  });

  it("does not treat legacy ID-card verification as complete when FaceID is required", () => {
    realnamePhoneVerificationEnabled = false;
    currentUser = {
      ...currentUser,
      phone: undefined,
      realnameVerified: true,
      realnameLevel: "idcard_2fa",
      realnameAssuranceMode: "observe",
    };

    renderAccountPage(false);

    expect(screen.queryByText("已认证")).not.toBeInTheDocument();
    expect(screen.getByText("需重新完成认证")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去认证" })).toBeInTheDocument();
  });

  it("shows desktop QR polling after FaceID attempt start and moves to the current-phone step only after backend state changes", async () => {
    startRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_desktop",
      verificationUrl: "https://faceid.example.invalid/attempt_desktop",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });
    getRealnameFaceIdAttempt
      .mockResolvedValueOnce({
        attemptId: "attempt_desktop",
        verificationUrl: "https://faceid.example.invalid/attempt_desktop",
        expiresAt: "2026-07-13T12:00:00.000Z",
        state: "pending",
      })
      .mockResolvedValueOnce({
        attemptId: "attempt_desktop",
        verificationUrl: "https://faceid.example.invalid/attempt_desktop",
        expiresAt: "2026-07-13T12:00:00.000Z",
        state: "phone_pending",
      });

    renderAccountPage();
    await openVerifyModal();

    const consent = screen.getByRole("checkbox", { name: /我已阅读.*并同意/ });
    await userEvent.type(screen.getByPlaceholderText("请输入真实姓名"), "张三");
    await userEvent.type(screen.getByPlaceholderText("请输入身份证号码"), "110101199001011234");
    expect(screen.getByRole("button", { name: "开始刷脸认证" })).toBeDisabled();

    await userEvent.click(consent);
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    expect(startRealnameFaceIdAttempt).toHaveBeenCalledWith({
      name: "张三",
      idCard: "110101199001011234",
      consent: true,
    });
    expect(await screen.findByText("请使用手机扫码完成人脸核身")).toBeInTheDocument();
    expect(screen.getByText(/有效期至/)).toBeInTheDocument();
    expect(screen.queryByText("当前手机号")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("当前手机号")).toBeInTheDocument();
    });
    expect(refreshProfile).not.toHaveBeenCalled();
  });

  it("shows the mobile direct-open action instead of the desktop QR panel", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    startRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_mobile",
      verificationUrl: "https://faceid.example.invalid/attempt_mobile",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });

    renderAccountPage();
    await openVerifyModal();
    await userEvent.type(screen.getByPlaceholderText("请输入真实姓名"), "张三");
    await userEvent.type(screen.getByPlaceholderText("请输入身份证号码"), "110101199001011234");
    await userEvent.click(screen.getByRole("checkbox", { name: /我已阅读.*并同意/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    expect(await screen.findByRole("link", { name: "打开刷脸页面" })).toHaveAttribute(
      "href",
      "https://faceid.example.invalid/attempt_mobile",
    );
    expect(screen.queryByText(/有效期至/)).not.toBeInTheDocument();
  });

  it("uses the FaceID flow in observe mode", async () => {
    currentUser = { ...currentUser, realnameAssuranceMode: "observe" };
    startRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_observe",
      verificationUrl: "https://faceid.example.invalid/attempt_observe",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });
    getRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_observe",
      verificationUrl: "https://faceid.example.invalid/attempt_observe",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });

    renderAccountPage();
    await openVerifyModal();
    await userEvent.type(screen.getByPlaceholderText("请输入真实姓名"), "张三");
    await userEvent.type(screen.getByPlaceholderText("请输入身份证号码"), "110101199001011234");
    await userEvent.click(screen.getByRole("checkbox", { name: /我已阅读.*并同意/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    expect(startRealnameFaceIdAttempt).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("请使用手机扫码完成人脸核身")).toBeInTheDocument();
  });

  it("requires a fresh FaceID attempt for legacy ID-card verification", async () => {
    currentUser = {
      ...currentUser,
      realnameVerified: true,
      realnameLevel: "idcard_2fa",
      realnameAssuranceMode: "observe",
    };
    startRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_legacy_idcard",
      verificationUrl: "https://faceid.example.invalid/attempt_legacy_idcard",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });
    getRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_legacy_idcard",
      verificationUrl: "https://faceid.example.invalid/attempt_legacy_idcard",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });

    renderAccountPage();
    await userEvent.click(screen.getByRole("button", { name: "继续认证" }));

    expect(screen.getByPlaceholderText("请输入真实姓名")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("请输入身份证号码")).toBeInTheDocument();
    expect(screen.queryByText("当前手机号")).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("请输入真实姓名"), "张三");
    await userEvent.type(screen.getByPlaceholderText("请输入身份证号码"), "110101199001011234");
    await userEvent.click(screen.getByRole("checkbox", { name: /我已阅读.*并同意/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    expect(startRealnameFaceIdAttempt).toHaveBeenCalledWith({
      name: "张三",
      idCard: "110101199001011234",
      consent: true,
    });
    expect(await screen.findByText("请使用手机扫码完成人脸核身")).toBeInTheDocument();
  });

  it("collects and verifies a phone only after a clean user finishes FaceID", async () => {
    currentUser = {
      ...currentUser,
      phone: undefined,
      realnameVerified: false,
      realnameLevel: undefined,
      realnameAssuranceMode: "observe",
    };
    startRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_clean_user",
      verificationUrl: "https://faceid.example.invalid/attempt_clean_user",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });
    getRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_clean_user",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "phone_pending",
    });
    verifyRealnameFaceIdPhone.mockResolvedValue({ attemptId: "attempt_clean_user", state: "succeeded" });
    refreshProfile.mockImplementation(async () => {
      currentUser = {
        ...currentUser,
        phone: "13800138123",
        realnameVerified: true,
        realnameLevel: "phone_3fa",
        realnameSyncStatus: "succeeded",
      };
      rerenderPage?.();
    });

    renderAccountPage();
    await openVerifyModal();
    expect(screen.queryByPlaceholderText("请输入中国大陆手机号")).not.toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("请输入真实姓名"), "张三");
    await userEvent.type(screen.getByPlaceholderText("请输入身份证号码"), "110101199001011234");
    await userEvent.click(screen.getByRole("checkbox", { name: /我已阅读.*并同意/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    const phoneInput = await screen.findByPlaceholderText("请输入中国大陆手机号");
    expect(phoneInput).toBeEnabled();
    await userEvent.type(phoneInput, "13800138123");
    await userEvent.click(screen.getByRole("button", { name: "获取验证码" }));
    expect(sendRealnameFaceIdPhoneCode).toHaveBeenCalledWith("attempt_clean_user", { phone: "13800138123" });
    await userEvent.type(screen.getByPlaceholderText("请输入短信验证码"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "完成手机号认证" }));

    expect(verifyRealnameFaceIdPhone).toHaveBeenCalledWith("attempt_clean_user", {
      phone: "13800138123",
      code: "123456",
    });
    await waitFor(() => expect(screen.getByText("已认证")).toBeInTheDocument());
  });

  it("does not treat focus or callback-like query changes as success", async () => {
    startRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_focus",
      verificationUrl: "https://faceid.example.invalid/attempt_focus",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });
    getRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_focus",
      verificationUrl: "https://faceid.example.invalid/attempt_focus",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });

    renderAccountPage();
    await openVerifyModal();
    await userEvent.type(screen.getByPlaceholderText("请输入真实姓名"), "张三");
    await userEvent.type(screen.getByPlaceholderText("请输入身份证号码"), "110101199001011234");
    await userEvent.click(screen.getByRole("checkbox", { name: /我已阅读.*并同意/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    getRealnameFaceIdAttempt.mockClear();
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.history.replaceState({}, "", "/account?faceid_callback=1");
    });

    await waitFor(() => expect(getRealnameFaceIdAttempt).toHaveBeenCalled());
    expect(screen.queryByText("当前手机号")).not.toBeInTheDocument();
    expect(refreshProfile).not.toHaveBeenCalled();
  });

  it("shows a restart action when the FaceID attempt expires", async () => {
    startRealnameFaceIdAttempt.mockResolvedValueOnce({
      attemptId: "attempt_expired",
      verificationUrl: "https://faceid.example.invalid/attempt_expired",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });
    getRealnameFaceIdAttempt.mockResolvedValueOnce({
      attemptId: "attempt_expired",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "expired",
    });
    startRealnameFaceIdAttempt.mockResolvedValueOnce({
      attemptId: "attempt_expired_2",
      verificationUrl: "https://faceid.example.invalid/attempt_expired_2",
      expiresAt: "2026-07-13T12:10:00.000Z",
      state: "pending",
    });

    renderAccountPage();
    await openVerifyModal();
    await userEvent.type(screen.getByPlaceholderText("请输入真实姓名"), "张三");
    await userEvent.type(screen.getByPlaceholderText("请输入身份证号码"), "110101199001011234");
    await userEvent.click(screen.getByRole("checkbox", { name: /我已阅读.*并同意/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    expect(await screen.findByText("本次刷脸已过期，请重新发起认证。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新开始认证" }));
    expect(screen.getByRole("button", { name: "开始刷脸认证" })).toBeInTheDocument();
  });

  it("returns provider verification failures to a fresh face scan instead of Shadow retry", async () => {
    startRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_failed",
      verificationUrl: "https://faceid.example.invalid/attempt_failed",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });
    getRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_failed",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "failed",
    });

    renderAccountPage();
    await openVerifyModal();
    await userEvent.type(screen.getByPlaceholderText("请输入真实姓名"), "张三");
    await userEvent.type(screen.getByPlaceholderText("请输入身份证号码"), "110101199001011234");
    await userEvent.click(screen.getByRole("checkbox", { name: /我已阅读.*并同意/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    expect(await screen.findByText("本次刷脸未通过，请重新发起认证。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新开始认证" })).toBeInTheDocument();
    expect(screen.queryByText("你无需重新刷脸，可直接重试当前实名同步。")).not.toBeInTheDocument();
    expect(retryRealnameSync).not.toHaveBeenCalled();
  });

  it("does not expose a manual Shadow retry while the backend owns FaceID completion", async () => {
    currentUser = {
      ...currentUser,
      realnameLevel: "phone_3fa",
      realnameSyncStatus: "failed",
      realnameVerified: false,
    };
    renderAccountPage();
    await userEvent.click(screen.getByRole("button", { name: /继续认证/ }));

    expect(screen.queryByRole("button", { name: /重新同步/ })).not.toBeInTheDocument();
    expect(retryRealnameSync).not.toHaveBeenCalled();
    expect(screen.queryByText("已认证")).not.toBeInTheDocument();
    expect(startRealnameFaceIdAttempt).not.toHaveBeenCalled();
  });

  it("marks the account as verified only after the backend attempt succeeds and the refreshed session becomes final", async () => {
    startRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_success",
      verificationUrl: "https://faceid.example.invalid/attempt_success",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "pending",
    });
    getRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_success",
      verificationUrl: "https://faceid.example.invalid/attempt_success",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "phone_pending",
    });
    verifyRealnameFaceIdPhone.mockResolvedValue({ attemptId: "attempt_success", state: "succeeded" });
    refreshProfile.mockImplementation(async () => {
      currentUser = {
        ...currentUser,
        realnameVerified: true,
        realnameLevel: "phone_3fa",
        realnameSyncStatus: "succeeded",
      };
      rerenderPage?.();
    });

    renderAccountPage();
    await openVerifyModal();
    await userEvent.type(screen.getByPlaceholderText("请输入真实姓名"), "张三");
    await userEvent.type(screen.getByPlaceholderText("请输入身份证号码"), "110101199001011234");
    await userEvent.click(screen.getByRole("checkbox", { name: /我已阅读.*并同意/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    await waitFor(() => {
      expect(screen.getByText("当前手机号")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "获取验证码" }));
    expect(sendRealnameFaceIdPhoneCode).toHaveBeenCalledWith("attempt_success", { phone: "15625128341" });
    expect(sendSmsCode).not.toHaveBeenCalled();
    await userEvent.type(screen.getByPlaceholderText("请输入短信验证码"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "完成当前手机号认证" }));

    expect(verifyRealnameFaceIdPhone).toHaveBeenCalledWith("attempt_success", {
      phone: "15625128341",
      code: "123456",
    });

    await waitFor(() => {
      expect(refreshProfile).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText("已认证")).toBeInTheDocument();
    });
    expect(finalizeRealnameFaceIdAttempt).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "完成实名同步" })).not.toBeInTheDocument();
    expect(screen.queryByText("请先完成刷脸核身，再继续当前手机号认证与 LightVela 同步。")).not.toBeInTheDocument();
  });

  it("refreshes the attempt instead of showing an SMS cooldown when Shadow proof is reused", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    let phoneProofReused = false;
    startRealnameFaceIdAttempt.mockResolvedValue({
      attemptId: "attempt_reused_phone",
      verificationUrl: "https://faceid.example.invalid/attempt_reused_phone",
      expiresAt: "2026-07-13T12:00:00.000Z",
      state: "phone_pending",
    });
    getRealnameFaceIdAttempt.mockImplementation(async () => (
      phoneProofReused
        ? {
            attemptId: "attempt_reused_phone",
            expiresAt: "2026-07-13T12:00:00.000Z",
            state: "succeeded",
          }
        : {
            attemptId: "attempt_reused_phone",
            expiresAt: "2026-07-13T12:00:00.000Z",
            state: "phone_pending",
          }
    ));
    sendRealnameFaceIdPhoneCode.mockImplementation(async () => {
      phoneProofReused = true;
      return { cooldownSeconds: 0 };
    });

    renderAccountPage();
    await openVerifyModal();
    await userEvent.type(screen.getByPlaceholderText("请输入真实姓名"), "张三");
    await userEvent.type(screen.getByPlaceholderText("请输入身份证号码"), "110101199001011234");
    await userEvent.click(screen.getByRole("checkbox", { name: /我已阅读.*并同意/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始刷脸认证" }));

    await waitFor(() => expect(screen.getByText("当前手机号")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    expect(sendRealnameFaceIdPhoneCode).toHaveBeenCalledWith("attempt_reused_phone", { phone: "15625128341" });
    expect(sendSmsCode).not.toHaveBeenCalled();
    await waitFor(() => expect(refreshProfile).toHaveBeenCalled());
    expect(finalizeRealnameFaceIdAttempt).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "完成实名同步" })).not.toBeInTheDocument();
    expect(screen.queryByText(/重新发送/)).not.toBeInTheDocument();
  });

  it("does not expose a frontend finalize action for a shadow-pending attempt", async () => {
    getCurrentRealnameFaceIdAttempt.mockResolvedValue({ attemptId: "attempt_restore", state: "shadow_pending" });

    renderAccountPage();
    await openVerifyModal();

    await waitFor(() => expect(screen.getByText("正在确认最终实名结果")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "完成实名同步" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新当前状态" })).not.toBeInTheDocument();
    expect(finalizeRealnameFaceIdAttempt).not.toHaveBeenCalled();
  });
});
