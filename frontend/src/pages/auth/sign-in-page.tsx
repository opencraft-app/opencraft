import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { installShowGitHubLoginHelper, useGitHubLoginVisibility } from "@/lib/github-login-visibility";
import {
  ALLOW_GITHUB_EASTER_EGG,
  oauthErrorMessage,
  redirectToOAuthStart,
  VISIBLE_OAUTH_PROVIDERS,
  type OAuthProvider,
} from "@/lib/oauth";
import { AuthShell } from "@/pages/auth/auth-shell";

/**
 * 单个 OAuth 按钮的视觉配置。
 * 保持与历史版本一致的风格：
 *  - QQ: 主色 Primary 按钮
 *  - WeChat: 绿色渐变
 *  - Google / GitHub: outline 风格（与游客按钮一致，便于国际站视觉统一）
 */
type ProviderVisual = {
  label: string;
  className: string;
  style?: React.CSSProperties;
};

const OUTLINE_CLASS =
  "h-12 w-full rounded-full border-[var(--lw-border)] bg-[var(--lw-bg-elevated)] text-[var(--lw-fg)] shadow-[var(--lw-shadow-base)] hover:border-[var(--lw-accent)] hover:bg-[var(--lw-accent-light)]";

const PROVIDER_VISUALS: Record<OAuthProvider, ProviderVisual> = {
  qq: {
    label: "使用 QQ 登录",
    className: "h-12 w-full",
  },
  wechat: {
    label: "使用微信登录",
    className: "h-12 w-full text-white",
    style: { background: "linear-gradient(135deg, #3cd278 0%, #07c160 100%)" },
  },
  google: {
    label: "使用 Google 登录",
    className: OUTLINE_CLASS,
  },
  github: {
    label: "使用 GitHub 登录",
    className: OUTLINE_CLASS,
  },
};

export const SignInPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const repositories = useRepositories();
  const { signInAsGuest } = useSession();
  const showGitHubLoginEgg = useGitHubLoginVisibility();
  const oauthLoginUrls: Record<OAuthProvider, string | null> = {
    qq: repositories.auth.getOAuthStartUrl("qq"),
    wechat: repositories.auth.getOAuthStartUrl("wechat"),
    google: repositories.auth.getOAuthStartUrl("google"),
    github: repositories.auth.getOAuthStartUrl("github"),
  };
  const oauthError = new URLSearchParams(location.search).get("oauth_error");
  const errorMessage = oauthErrorMessage(oauthError);

  const [guestLoading, setGuestLoading] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);

  useEffect(() => installShowGitHubLoginHelper(), []);

  const handleOAuthLogin = async (provider: OAuthProvider) => {
    const loginUrl = oauthLoginUrls[provider];
    if (!loginUrl) {
      return;
    }
    redirectToOAuthStart(loginUrl);
  };

  const handleGuestLogin = async () => {
    setGuestLoading(true);
    setGuestError(null);
    try {
      await signInAsGuest();
      navigate("/", { replace: true });
    } catch {
      setGuestError("游客登录失败，请稍后重试。");
    } finally {
      setGuestLoading(false);
    }
  };

  /**
   * 实际渲染的 provider 列表：
   *  - 国际站：固定 google + github（由 VISIBLE_OAUTH_PROVIDERS 决定，编译期裁剪）
   *  - 国内站：qq + wechat；若通过 show_github_login() 触发彩蛋，则额外追加 github
   */
  const providersToRender: OAuthProvider[] = [...VISIBLE_OAUTH_PROVIDERS];
  if (
    ALLOW_GITHUB_EASTER_EGG &&
    showGitHubLoginEgg &&
    !providersToRender.includes("github")
  ) {
    providersToRender.push("github");
  }

  return (
    <AuthShell title="进入 LightVela" subtitle="选择一种方式开始体验。" showShowcase>
      <div className="space-y-4">
        {providersToRender.map((provider) => {
          const url = oauthLoginUrls[provider];
          if (!url) return null;
          const visual = PROVIDER_VISUALS[provider];
          return (
            <Button
              key={provider}
              onClick={() => void handleOAuthLogin(provider)}
              variant={provider === "qq" || provider === "wechat" ? undefined : "outline"}
              className={visual.className}
              style={visual.style}
            >
              {visual.label}
            </Button>
          );
        })}
        <Button
          onClick={handleGuestLogin}
          disabled={guestLoading}
          variant="outline"
          className="h-12 w-full rounded-full border-[var(--lw-border)] bg-[var(--lw-bg-elevated)] text-[var(--lw-fg)] shadow-[var(--lw-shadow-base)] hover:border-[var(--lw-accent)] hover:bg-[var(--lw-accent-light)]"
        >
          {guestLoading ? "正在进入..." : "游客体验"}
        </Button>
        <p className="text-center text-xs" style={{ color: "var(--lw-fg-tertiary)" }}>
          游客模式无需注册，可直接体验产品功能
        </p>
      </div>
      {errorMessage ? <p className="text-sm text-[var(--danger)]">{errorMessage}</p> : null}
      {guestError ? <p className="text-sm text-[var(--danger)]">{guestError}</p> : null}
    </AuthShell>
  );
};
