import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { AuthShell } from "@/pages/auth/auth-shell";
import { OAuthLoginEntry } from "@/pages/auth/oauth-login-entry";

export const SignInPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const repositories = useRepositories();
  const { signInAsGuest } = useSession();
  const qqLoginUrl = repositories.auth.getOAuthStartUrl("qq");
  const [inviteCode, setInviteCode] = useState("");
  const oauthError = new URLSearchParams(location.search).get("oauth_error");
  const errorMessage =
    oauthError === "qq_exchange_failed" || oauthError === "qq_identity_failed" || oauthError === "qq_sign_in_failed"
      ? "QQ 登录暂时失败，请稍后重试。"
      : oauthError === "invite_required"
        ? "首次使用需要先通过邀请码校验。"
      : oauthError === "qq_state_mismatch"
        ? "登录态已过期，请重新发起 QQ 登录。"
        : null;

  const [guestLoading, setGuestLoading] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const normalizedInviteCode = inviteCode.trim().toUpperCase();

  const handleQQLogin = async () => {
    if (!qqLoginUrl) {
      return;
    }
    setInviteError(null);
    try {
      if (normalizedInviteCode) {
        await repositories.auth.prepareInviteCode(normalizedInviteCode);
      }
      window.location.assign(qqLoginUrl);
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : "邀请码校验失败，请稍后重试。");
    }
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
    <AuthShell title="进入 Lightclaw" subtitle="选择一种方式开始体验。" showShowcase>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="sign-in-invite-code">邀请码</Label>
          <Input
            id="sign-in-invite-code"
            autoComplete="one-time-code"
            placeholder="首次使用前请输入邀请码"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value.trim().toUpperCase())}
          />
        </div>
        {qqLoginUrl ? (
          <Button onClick={() => void handleQQLogin()} className="h-12 w-full">
            使用 QQ 登录
          </Button>
        ) : (
          <OAuthLoginEntry href={qqLoginUrl} />
        )}
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
      {inviteError ? <p className="text-sm text-[var(--danger)]">{inviteError}</p> : null}
      {guestError ? <p className="text-sm text-[var(--danger)]">{guestError}</p> : null}
    </AuthShell>
  );
};
