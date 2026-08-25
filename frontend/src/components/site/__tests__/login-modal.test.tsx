import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGitHubLoginVisible } from "@/lib/github-login-visibility";
import { CN_PRIVACY_POLICY_URL } from "@/constants/legal";
import * as oauthModule from "@/lib/oauth";
import { LoginModal } from "@/components/site/login-modal";
import type { OAuthProvider, WeChatOAuthMode } from "@/lib/oauth";
import {
  captureProductEvent,
  PRODUCT_ANALYTICS_EVENTS,
} from "@/observability/posthog";

vi.mock("@/observability/posthog", () => ({
  captureProductEvent: vi.fn(),
  PRODUCT_ANALYTICS_EVENTS: {
    LOGIN_MODAL_OPENED: "login_modal_opened",
    OAUTH_PROVIDER_CLICKED: "oauth_provider_clicked",
  },
  PRODUCT_ANALYTICS_LOCATIONS: { LOGIN_MODAL: "login_modal" },
}));

const signInWithCode = vi.fn();
const writeClipboardText = vi.fn();
const execCommandCopy = vi.fn();
let currentSession: {
  stage: "anonymous" | "authenticated";
  user: { id: string; name: string } | null;
};

const repositories = {
  auth: {
    getOAuthStartUrl: vi.fn((
      provider: OAuthProvider,
      options?: { switchAccount?: boolean; wechatMode?: WeChatOAuthMode },
    ) => {
      const query = new URLSearchParams();
      if (provider === "wechat" && options?.wechatMode) query.set("mode", options.wechatMode);
      if (options?.switchAccount) query.set("switch_account", "true");
      const querySuffix = query.size > 0 ? `?${query.toString()}` : "";
      switch (provider) {
        case "qq":
          return "https://lightclaw.tech/auth/oauth/qq/start";
        case "wechat":
          return `https://lightclaw.tech/auth/oauth/wechat/start${querySuffix}`;
        case "google":
          return "https://lightclaw.tech/auth/oauth/google/start";
        case "github":
          return "https://lightclaw.tech/auth/oauth/github/start";
        default:
          return null;
      }
    }),
  },
};

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositories,
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: currentSession,
    signInWithCode,
  }),
}));

describe("LoginModal (国内站 默认 isGlobal=false)", () => {
  beforeEach(() => {
    currentSession = { stage: "anonymous", user: null };
    signInWithCode.mockReset().mockResolvedValue(undefined);
    repositories.auth.getOAuthStartUrl.mockClear();
    setGitHubLoginVisible(false);
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      configurable: true,
    });
    writeClipboardText.mockReset().mockResolvedValue(undefined);
    execCommandCopy.mockReset().mockReturnValue(false);
    vi.mocked(captureProductEvent).mockClear();
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: writeClipboardText },
      configurable: true,
    });
    Object.defineProperty(document, "execCommand", {
      value: execCommandCopy,
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("通过 portal 挂载到 body，避免继承 header 的定位上下文", async () => {
    const { container } = render(
      <header data-testid="header-shell" style={{ position: "fixed", backdropFilter: "blur(20px)" }}>
        <LoginModal open onClose={vi.fn()} />
      </header>,
    );

    const dialog = await screen.findByRole("dialog", { name: "登录" });
    expect(container).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
  });

  it("默认展示微信账号登录按钮，并把手机 / QQ 收束到底部其他登录方式", () => {
    render(<LoginModal open onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "微信登录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "微信账号登录" })).toBeInTheDocument();
    expect(screen.queryByText("使用微信账号继续登录")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手机" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "QQ" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "GitHub 登录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Google 登录" })).not.toBeInTheDocument();
  });

  it("切换到手机登录后，微信和 QQ 出现在底部其他登录选项", () => {
    render(<LoginModal open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "手机" }));

    expect(screen.getByRole("heading", { name: "手机登录" })).toBeInTheDocument();
    expect(screen.queryByText("使用手机号和短信验证码登录")).not.toBeInTheDocument();
    expect(screen.getByLabelText("手机号")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "微信" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "QQ" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "手机" })).not.toBeInTheDocument();
  });

  it("国内站其他登录方式下方保留弹窗底部空间", () => {
    render(<LoginModal open onClose={vi.fn()} />);

    const otherLoginTitle = screen.getByText("其他登录方式");
    const domesticContent = otherLoginTitle.parentElement?.parentElement;

    expect(domesticContent).toHaveClass("pb-6");
  });

  it("手机登录时协议勾选展示在登录按钮上方", () => {
    render(<LoginModal open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "手机" }));

    const agreementCheckbox = screen.getByRole("checkbox", {
      name: "我已阅读并同意 《服务协议》 与 《隐私保护协议》",
    });
    const submitButton = screen.getByRole("button", { name: "登录" });

    expect(
      agreementCheckbox.compareDocumentPosition(submitButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("国内站隐私协议跳转腾讯隐私中心", () => {
    render(<LoginModal open onClose={vi.fn()} />);

    expect(screen.getByRole("link", { name: "《隐私保护协议》" })).toHaveAttribute(
      "href",
      CN_PRIVACY_POLICY_URL,
    );
  });

  it("默认微信登录勾选协议后跳转现有 OAuth start URL", () => {
    const redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);

    render(<LoginModal open onClose={vi.fn()} />);

    const [agreeCheckbox] = screen.getAllByRole("checkbox");
    fireEvent.click(agreeCheckbox as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "微信账号登录" }));

    expect(redirectSpy).toHaveBeenCalledWith("https://lightclaw.tech/auth/oauth/wechat/start?mode=website");
    redirectSpy.mockRestore();
  });

  it("普通移动浏览器展示复制引导并复制公众号 OAuth 链接", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      configurable: true,
    });
    const redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);

    render(<LoginModal open onClose={vi.fn()} />);

    const guidePrompt = await screen.findByText("复制链接，前往「微信」打开");
    const copyButton = await screen.findByRole("button", { name: "复制链接" });
    expect(guidePrompt).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "微信账号登录" })).not.toBeInTheDocument();
    expect(copyButton).toHaveFocus();
    expect(copyButton).toHaveAttribute("aria-describedby", expect.stringContaining(guidePrompt.id));
    expect(copyButton).toHaveClass("rounded-full", "text-sm", "font-medium");
    expect(copyButton).not.toHaveClass("rounded-lg", "text-base");
    expect(guidePrompt).toHaveClass("text-sm", "font-medium");
    expect(guidePrompt).not.toHaveClass("text-base");
    expect(repositories.auth.getOAuthStartUrl).toHaveBeenLastCalledWith("wechat", {
      wechatMode: "official_account",
    });
    expect(redirectSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(
        "https://lightclaw.tech/auth/oauth/wechat/start?mode=official_account",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent("已复制，请打开微信粘贴访问");
    expect(captureProductEvent).toHaveBeenCalledWith(
      PRODUCT_ANALYTICS_EVENTS.OAUTH_PROVIDER_CLICKED,
      { provider: "wechat", action: "copy_link" },
    );
    redirectSpy.mockRestore();
  });

  it("普通移动浏览器默认展示引导，但未勾选协议时不能复制", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      configurable: true,
    });

    render(<LoginModal open onClose={vi.fn()} />);

    expect(await screen.findByText("复制链接，前往「微信」打开")).toBeInTheDocument();
    const copyButton = screen.getByRole("button", { name: "复制链接" });
    expect(copyButton).toHaveAttribute("aria-disabled", "true");
    expect(copyButton).toHaveClass("cursor-not-allowed", "opacity-50");
    fireEvent.click(copyButton);

    expect(screen.getByText("请先勾选同意服务协议")).toBeInTheDocument();
    expect(writeClipboardText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(copyButton).toHaveAttribute("aria-disabled", "false");
    expect(copyButton).not.toHaveClass("cursor-not-allowed", "opacity-50");
  });

  it("Clipboard API 失败时降级使用 execCommand 复制", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36",
      configurable: true,
    });
    writeClipboardText.mockRejectedValueOnce(new Error("clipboard denied"));
    execCommandCopy.mockReturnValueOnce(true);

    render(<LoginModal open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "复制链接" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("已复制，请打开微信粘贴访问");
    });
    expect(execCommandCopy).toHaveBeenCalledWith("copy");
    expect(screen.queryByRole("textbox", { name: "微信登录链接" })).not.toBeInTheDocument();
  });

  it("两种复制方式都失败时展示可长按复制的原始链接", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36",
      configurable: true,
    });
    writeClipboardText.mockRejectedValueOnce(new Error("clipboard denied"));
    execCommandCopy.mockReturnValueOnce(false);

    render(<LoginModal open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "复制链接" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("复制失败，请长按复制下方链接");
    });
    expect(screen.getByRole("textbox", { name: "微信登录链接" })).toHaveValue(
      "https://lightclaw.tech/auth/oauth/wechat/start?mode=official_account",
    );
  });

  it("进入引导后取消勾选协议会阻止复制", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1",
      configurable: true,
    });

    render(<LoginModal open onClose={vi.fn()} />);

    const agreeCheckbox = screen.getByRole("checkbox");
    fireEvent.click(agreeCheckbox);
    fireEvent.click(agreeCheckbox);
    fireEvent.click(await screen.findByRole("button", { name: "复制链接" }));

    expect(screen.getByText("请先勾选同意服务协议")).toBeInTheDocument();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("切换账号模式的移动端复制链接保留切换意图", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1",
      configurable: true,
    });

    render(
      <LoginModal
        open
        mode="switch-account"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "复制链接" }));

    expect(repositories.auth.getOAuthStartUrl).toHaveBeenCalledWith("wechat", {
      switchAccount: true,
      wechatMode: "official_account",
    });
    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(
        "https://lightclaw.tech/auth/oauth/wechat/start?mode=official_account&switch_account=true",
      );
    });
  });

  it("普通移动浏览器切回微信时直接恢复复制引导", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1",
      configurable: true,
    });

    render(<LoginModal open onClose={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "复制链接" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "手机" }));
    fireEvent.click(screen.getByRole("button", { name: "微信" }));

    const restoredCopyButton = await screen.findByRole("button", { name: "复制链接" });
    expect(restoredCopyButton).toBeInTheDocument();
    expect(restoredCopyButton).not.toHaveFocus();
    expect(screen.queryByRole("button", { name: "微信账号登录" })).not.toBeInTheDocument();
  });

  it("切换到 QQ 并勾选协议后，点击主按钮跳转后端下发的 start URL", () => {
    const redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);

    render(<LoginModal open onClose={vi.fn()} />);

    const [agreeCheckbox] = screen.getAllByRole("checkbox");
    expect(agreeCheckbox).toBeDefined();
    fireEvent.click(agreeCheckbox as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "QQ" }));

    expect(screen.queryByText("使用 QQ 账号继续登录")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "QQ账号登录" }));

    expect(screen.getByRole("button", { name: "微信" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手机" })).toBeInTheDocument();
    expect(redirectSpy).toHaveBeenCalledWith("https://lightclaw.tech/auth/oauth/qq/start");
    redirectSpy.mockRestore();
  });

  it("未勾选协议时点击 QQ 展示提示而不是静默无响应", () => {
    const redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);

    render(<LoginModal open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "QQ" }));
    const qqButton = screen.getByRole("button", { name: "QQ账号登录" });
    expect(qqButton).not.toBeDisabled();
    expect(qqButton).toHaveAttribute("aria-disabled", "true");
    expect(qqButton).toHaveClass("cursor-not-allowed", "opacity-50");
    fireEvent.click(qqButton);

    expect(screen.getByText("请先勾选同意服务协议")).toBeInTheDocument();
    expect(redirectSpy).not.toHaveBeenCalled();
    redirectSpy.mockRestore();
  });

  it("手机登录未勾选协议时不提交并展示统一协议提示", () => {
    render(<LoginModal open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "手机" }));
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "15625128341" } });
    fireEvent.change(screen.getByLabelText("短信验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(screen.getByText("请先勾选同意服务协议")).toBeInTheDocument();
    expect(signInWithCode).not.toHaveBeenCalled();
  });

  it("彩蛋 show_github_login() 触发后展示 GitHub 入口", async () => {
    setGitHubLoginVisible(false);
    render(<LoginModal open onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "GitHub 登录" })).not.toBeInTheDocument();
    (window.show_github_login as () => boolean)();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "GitHub 登录" })).toBeInTheDocument();
    });
  });

  it("普通登录保持已登录即关闭的既有行为", async () => {
    currentSession = { stage: "authenticated", user: { id: "usr_current", name: "当前账号" } };
    const onClose = vi.fn();
    const onSuccess = vi.fn();

    render(<LoginModal open onClose={onClose} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it("授权页登录成功不会误触发取消回调", async () => {
    currentSession = { stage: "authenticated", user: { id: "usr_current", name: "当前账号" } };
    const onClose = vi.fn();
    const onSuccess = vi.fn();

    render(
      <LoginModal
        open
        closeOnSuccess={false}
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("切换账号模式保留当前会话并为 OAuth 添加切换意图", async () => {
    currentSession = { stage: "authenticated", user: { id: "usr_current", name: "当前账号" } };
    const onClose = vi.fn();
    const onReturnToCurrentAccount = vi.fn();
    const redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);

    render(
      <LoginModal
        open
        mode="switch-account"
        onClose={onClose}
        onReturnToCurrentAccount={onReturnToCurrentAccount}
      />,
    );

    expect(screen.getByRole("dialog", { name: "切换其他账号" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "返回使用当前账号" }));
    expect(onReturnToCurrentAccount).toHaveBeenCalledTimes(1);

    const [agreeCheckbox] = screen.getAllByRole("checkbox");
    fireEvent.click(agreeCheckbox as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "微信账号登录" }));

    expect(repositories.auth.getOAuthStartUrl).toHaveBeenLastCalledWith("wechat", {
      switchAccount: true,
      wechatMode: "website",
    });
    expect(redirectSpy).toHaveBeenCalledWith(
      "https://lightclaw.tech/auth/oauth/wechat/start?mode=website&switch_account=true",
    );
    redirectSpy.mockRestore();
  });
});
