import { AnimatePresence, motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { installShowGitHubLoginHelper, useGitHubLoginVisibility } from "@/lib/github-login-visibility";
import { redirectToOAuthStart, type OAuthProvider } from "@/lib/oauth";
import { assetUrl } from "@/lib/asset-url";

const qqLogo = assetUrl("/login/qq-logo.png");
const wechatLogo = assetUrl("/login/wechat-logo.png");

/* ─── WeChat icon (保留 inline SVG 以便其他页面复用) ─── */

export const WeChatIcon = ({ className = "h-7 w-7" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="#07C160">
    <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.531c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05a6.127 6.127 0 0 1-.253-1.726c0-3.573 3.263-6.473 7.29-6.473.257 0 .508.02.76.042C16.538 4.924 12.905 2.188 8.691 2.188zm-2.5 4.202a1.141 1.141 0 1 1 0 2.283 1.141 1.141 0 0 1 0-2.283zm5.073 0a1.141 1.141 0 1 1 0 2.283 1.141 1.141 0 0 1 0-2.283zM24 14.83c0-3.248-3.263-5.883-7.29-5.883-4.033 0-7.29 2.635-7.29 5.883 0 3.248 3.257 5.883 7.29 5.883.83 0 1.63-.121 2.378-.343a.68.68 0 0 1 .564.078l1.502.878a.262.262 0 0 0 .13.044c.128 0 .234-.105.234-.236 0-.058-.023-.112-.038-.17l-.305-1.163a.47.47 0 0 1 .168-.524C23.004 18.39 24 16.724 24 14.83zm-9.655-1.03a.912.912 0 1 1 0-1.825.912.912 0 0 1 0 1.824zm4.728 0a.912.912 0 1 1 0-1.825.912.912 0 0 1 0 1.824z" />
  </svg>
);

/* ─── Login Modal Props ─── */

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
  /** 登录成功后的回调（可选），默认仅关闭弹窗 */
  onSuccess?: () => void;
  initialError?: string | null;
}

/* ─── Login Modal Component ─── */

export const LoginModal = ({ open, onClose, onSuccess, initialError = null }: LoginModalProps) => {
  const repositories = useRepositories();
  const { session } = useSession();
  const showGitHubLogin = useGitHubLoginVisibility();
  const oauthLoginUrls: Record<OAuthProvider, string | null> = {
    qq: repositories.auth.getOAuthStartUrl("qq"),
    wechat: repositories.auth.getOAuthStartUrl("wechat"),
    google: repositories.auth.getOAuthStartUrl("google"),
    github: repositories.auth.getOAuthStartUrl("github"),
  };

  const [agreed, setAgreed] = useState(false);
  const [showAgreeHint, setShowAgreeHint] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => installShowGitHubLoginHelper(), []);

  // 当用户已登录时自动关闭弹窗并触发 onSuccess
  useEffect(() => {
    if (!open) return;
    if (session.stage === "authenticated" && session.user) {
      onClose();
      onSuccess?.();
    }
  }, [open, session.stage, session.user, onClose, onSuccess]);

  useEffect(() => {
    if (!open) return;
    setError(initialError);
  }, [initialError, open]);

  const checkAgreed = () => {
    if (!agreed) {
      setShowAgreeHint(true);
      return false;
    }
    return true;
  };

  /* 统一的 OAuth 登录跳转入口 */
  const handleOAuthLogin = (provider: OAuthProvider) => {
    if (!checkAgreed()) return;
    const loginUrl = oauthLoginUrls[provider];
    if (!loginUrl) return;
    setError(null);
    redirectToOAuthStart(loginUrl);
  };

  return (
    <>
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            className="relative mx-4 flex w-full max-w-[412px] flex-col overflow-hidden shadow-2xl"
            style={{
              background: "#fff",
              borderRadius: 12,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={onClose}
              className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[rgba(0,0,0,0.05)]"
              style={{ color: "rgba(0,0,0,0.5)" }}
              aria-label="关闭"
            >
              <X className="h-5 w-5" />
            </button>

            {/* Header — 标题 + 副标题（按设计稿不展示 Logo） */}
            <div className="flex w-full flex-col items-center px-9 pt-10">
              <h2
                className="text-[28px] font-medium leading-none"
                style={{ color: "rgba(0,0,0,0.9)" }}
              >
                登录
              </h2>
              <p
                className="mt-4 text-sm"
                style={{ color: "rgba(0,0,0,0.5)" }}
              >
                使用社交软件一键登录
              </p>
            </div>

            {/* OAuth Login buttons — 放在 radio 上方 */}
            <div className="flex w-full flex-col gap-4 px-9 pt-8">
              {oauthLoginUrls.qq && (
                <button
                  type="button"
                  onClick={() => handleOAuthLogin("qq")}
                  disabled={!agreed}
                  className="group relative flex w-full items-center justify-center gap-2 rounded-full border px-8 py-[10px] text-sm font-medium transition-all duration-200 hover:shadow-sm active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none"
                  style={{
                    background: "linear-gradient(171deg, #F8F9FF 0%, #FFFFFF 100%)",
                    borderColor: "#E6E9EF",
                    color: "#202020",
                  }}
                >
                  <img
                    src={qqLogo}
                    alt="QQ"
                    className="h-8 w-8 select-none object-contain pointer-events-none"
                  />
                  <span>QQ账号登录</span>
                </button>
              )}
              {oauthLoginUrls.wechat && (
                <button
                  type="button"
                  onClick={() => handleOAuthLogin("wechat")}
                  disabled={!agreed}
                  className="group relative flex w-full items-center justify-center gap-2 rounded-full border px-8 py-[10px] text-sm font-medium transition-all duration-200 hover:shadow-sm active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none"
                  style={{
                    background: "linear-gradient(172deg, #F8FFF8 0%, #FFFFFF 100%)",
                    borderColor: "#E6E9EF",
                    color: "#202020",
                  }}
                >
                  <img
                    src={wechatLogo}
                    alt="微信"
                    className="h-8 w-8 select-none object-contain pointer-events-none"
                  />
                  <span>微信账号登录</span>
                </button>
              )}
              {showGitHubLogin && oauthLoginUrls.github ? (
                <button
                  type="button"
                  onClick={() => handleOAuthLogin("github")}
                  disabled={!agreed}
                  className="group relative flex w-full items-center justify-center gap-2 rounded-full border px-8 py-[10px] text-sm font-medium transition-all duration-200 hover:shadow-sm active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none"
                  style={{
                    background: "linear-gradient(171deg, #F8F9FF 0%, #FFFFFF 100%)",
                    borderColor: "#E6E9EF",
                    color: "#202020",
                  }}
                >
                  <span>GitHub 登录</span>
                </button>
              ) : null}
              {/* Google 登录暂不在弹窗展示，如需开启可参考 sign-in-page */}
            </div>

            {/* Agreement — 放在登录按钮下方，必须先同意 */}
            <div className="flex w-full flex-col items-center px-9 pb-6 pt-5">
              <label className="flex cursor-pointer items-start gap-2 select-none">
                <div className="relative mt-0.5 flex-shrink-0">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => {
                      setAgreed(e.target.checked);
                      if (e.target.checked) setShowAgreeHint(false);
                    }}
                    className="peer sr-only"
                  />
                  <div
                    className="flex h-4 w-4 items-center justify-center rounded-full border-[1.5px] transition-all duration-200 peer-checked:border-[var(--lw-accent)] peer-checked:bg-[var(--lw-accent)]"
                    style={{
                      borderColor: showAgreeHint ? "#cf3d4c" : "#ccc",
                    }}
                  >
                    {agreed && (
                      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 6l3 3 5-5" />
                      </svg>
                    )}
                  </div>
                </div>
                <span className="text-xs leading-relaxed text-[var(--text-tertiary)]">
                  我已阅读并同意{" "}
                  <a
                    href="https://cloud.tencent.com/document/product/301/48034"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline"
                    style={{ color: "var(--lw-accent)" }}
                  >
                    《服务协议》
                  </a>{" "}
                  与{" "}
                  <a
                    href="https://cloud.tencent.com/document/product/301/11470"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline"
                    style={{ color: "var(--lw-accent)" }}
                  >
                    《隐私保护协议》
                  </a>
                </span>
              </label>
              {/* Agree hint */}
              <AnimatePresence>
                {showAgreeHint && (
                  <motion.p
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="mt-2 text-xs font-medium text-[var(--danger)]"
                  >
                    请先勾选同意服务协议
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="w-full px-8 pb-6"
                >
                  <p className="text-center text-xs font-medium text-[var(--danger)]">{error}</p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Bottom spacing when no error */}
            {!error && <div className="pb-2" />}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  );
};

/* ═══════════════════════════════════════════════════════════════
   Invite Code Modal — 登录后无创建权限时弹出引导输入邀请码
   ═══════════════════════════════════════════════════════════════ */

interface InviteCodeModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const InviteCodeModal = ({ open, onClose, onSuccess }: InviteCodeModalProps) => {
  const repositories = useRepositories();
  const { session, activateInviteCode } = useSession();
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const code = inviteCode.trim().toUpperCase();
    if (!code) {
      setError("请输入邀请码。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (session.stage === "authenticated" && session.user) {
        await activateInviteCode(code);
      } else {
        await repositories.auth.prepareInviteCode(code);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "邀请码校验失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            className="relative mx-4 flex w-full max-w-sm flex-col items-center overflow-hidden rounded-2xl border shadow-2xl"
            style={{
              background: "#fff",
              borderColor: "rgba(238,238,238,0.4)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={onClose}
              className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[rgba(0,0,0,0.05)]"
              style={{ color: "#999" }}
            >
              <X className="h-4 w-4" />
            </button>

            {/* Header */}
            <div className="flex w-full flex-col items-center px-8 pb-2 pt-10">
              <div
                className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl"
                style={{
                  background: "linear-gradient(135deg, rgba(247,102,91,0.1) 0%, rgba(247,102,91,0.05) 100%)",
                }}
              >
                <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="var(--lw-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-[var(--text-primary)]">
                输入邀请码
              </h2>
              <p className="mt-1 text-center text-sm text-[var(--text-tertiary)]">
                创建 Hermes 需要先输入邀请码激活权限
              </p>
            </div>

            {/* Invite code input */}
            <div className="flex w-full flex-col gap-3 px-8 pb-4 pt-4">
              <input
                type="text"
                autoComplete="one-time-code"
                placeholder="请输入邀请码"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.trim().toUpperCase())}
                className="w-full rounded-[1rem] border border-[var(--border-subtle)] px-4 py-3 text-center text-base tracking-widest text-[var(--text-primary)] outline-none transition-all duration-250 focus:border-[var(--lw-accent)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              />

              <Button
                onClick={() => void handleSubmit()}
                disabled={loading || !inviteCode.trim()}
                className="h-auto w-full py-3.5 text-base"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {loading ? "验证中..." : "确认"}
              </Button>
            </div>

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="w-full px-8 pb-6"
                >
                  <p className="text-center text-xs font-medium text-[var(--danger)]">{error}</p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Bottom spacing when no error */}
            {!error && <div className="pb-6" />}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
