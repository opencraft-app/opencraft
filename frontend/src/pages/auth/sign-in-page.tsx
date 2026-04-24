import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { installShowGitHubLoginHelper, useGitHubLoginVisibility } from "@/lib/github-login-visibility";
import { oauthErrorMessage, redirectToOAuthStart, type OAuthProvider } from "@/lib/oauth";
import { AuthShell } from "@/pages/auth/auth-shell";

export const SignInPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const repositories = useRepositories();
  const { signInAsGuest } = useSession();
  const showGitHubLogin = useGitHubLoginVisibility();
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

  return (
    <AuthShell title="进入 LightVela" subtitle="选择一种方式开始体验。" showShowcase>
      <div className="space-y-4">
        {oauthLoginUrls.qq ? (
          <Button onClick={() => void handleOAuthLogin("qq")} className="h-12 w-full">
            使用 QQ 登录
          </Button>
        ) : null}
        {oauthLoginUrls.wechat ? (
          <Button
            onClick={() => void handleOAuthLogin("wechat")}
            className="h-12 w-full text-white"
            style={{ background: "linear-gradient(135deg, #3cd278 0%, #07c160 100%)" }}
          >
            使用微信登录
          </Button>
        ) : null}
        {oauthLoginUrls.google ? (
          <Button
            onClick={() => void handleOAuthLogin("google")}
            variant="outline"
            className="h-12 w-full rounded-full border-[var(--lw-border)] bg-[var(--lw-bg-elevated)] text-[var(--lw-fg)] shadow-[var(--lw-shadow-base)] hover:border-[var(--lw-accent)] hover:bg-[var(--lw-accent-light)]"
          >
            使用 Google 登录
          </Button>
        ) : null}
        {showGitHubLogin && oauthLoginUrls.github ? (
          <Button
            onClick={() => void handleOAuthLogin("github")}
            variant="outline"
            className="h-12 w-full rounded-full border-[var(--lw-border)] bg-[var(--lw-bg-elevated)] text-[var(--lw-fg)] shadow-[var(--lw-shadow-base)] hover:border-[var(--lw-accent)] hover:bg-[var(--lw-accent-light)]"
          >
            使用 GitHub 登录
          </Button>
        ) : null}
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
