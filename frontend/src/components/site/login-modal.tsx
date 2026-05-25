import { AnimatePresence, motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { installShowGitHubLoginHelper, useGitHubLoginVisibility } from "@/lib/github-login-visibility";
import {
  ALLOW_GITHUB_EASTER_EGG,
  redirectToOAuthStart,
  VISIBLE_OAUTH_PROVIDERS,
  type OAuthProvider,
} from "@/lib/oauth";
import { assetUrl } from "@/lib/asset-url";
import { isGlobal } from "@/lib/region";

const qqLogo = assetUrl("/login/qq-logo.png");
const wechatLogo = assetUrl("/login/wechat-logo.png");

/**
 * OAuth 按钮在弹窗中的视觉配置
 * - QQ / WeChat：沿用国内站原有的渐变底 + 品牌 logo 图
 * - Google / GitHub：沿用同款圆角浅色风格，图标用 SVG 占位（后续可换官方 brand assets）
 */
const BUTTON_BASE_CLASS =
  "group relative flex w-full items-center justify-center gap-2 rounded-full border px-8 py-[10px] text-sm font-medium transition-all duration-200 hover:shadow-sm active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none";

type ProviderButtonVisual = {
  /** i18n key 原文（中文），渲染时由 useT() 转换 */
  label: string;
  style: React.CSSProperties;
  renderIcon: () => React.ReactNode;
};

const PROVIDER_BUTTON_VISUALS: Record<OAuthProvider, ProviderButtonVisual> = {
  qq: {
    label: "QQ账号登录",
    style: {
      background: "linear-gradient(171deg, #F8F9FF 0%, #FFFFFF 100%)",
      borderColor: "#E6E9EF",
      color: "#202020",
    },
    renderIcon: () => (
      <img
        src={qqLogo}
        alt="QQ"
        className="h-8 w-8 select-none object-contain pointer-events-none"
      />
    ),
  },
  wechat: {
    label: "微信账号登录",
    style: {
      background: "linear-gradient(172deg, #F8FFF8 0%, #FFFFFF 100%)",
      borderColor: "#E6E9EF",
      color: "#202020",
    },
    renderIcon: () => (
      <img
        src={wechatLogo}
        alt="微信"
        className="h-8 w-8 select-none object-contain pointer-events-none"
      />
    ),
  },
  google: {
    label: "Google 登录",
    style: {
      background: "linear-gradient(171deg, #F8F9FF 0%, #FFFFFF 100%)",
      borderColor: "#E6E9EF",
      color: "#202020",
    },
    /* Google 官方 Google G logo（多彩）——占位用内联 SVG，资源落地后可替换为 img */
    renderIcon: () => (
      <svg viewBox="0 0 48 48" className="h-7 w-7 select-none pointer-events-none" aria-hidden="true">
        <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
        <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
        <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
        <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-0.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C37.029 36.528 44 31.333 44 24c0-1.341-.138-2.65-.389-3.917z"/>
      </svg>
    ),
  },
  github: {
    label: "GitHub 登录",
    style: {
      background: "linear-gradient(171deg, #F8F9FF 0%, #FFFFFF 100%)",
      borderColor: "#E6E9EF",
      color: "#202020",
    },
    renderIcon: () => (
      <svg
        viewBox="0 0 24 24"
        className="h-7 w-7 select-none pointer-events-none"
        fill="#181717"
        aria-hidden="true"
      >
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.11.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
      </svg>
    ),
  },
};

/**
 * i18n 注册点：PROVIDER_BUTTON_VISUALS 里的 label 是普通字符串字面量，
 * i18n-extract 脚本只扫 t("...") 调用；这里显式写一遍让字典收录。
 * 该变量仅用于静态分析，运行时不会被使用（tree-shake 友好）。
 */
const _I18N_PROVIDER_LABEL_KEYS = (t: (s: string) => string) => [
  t("QQ账号登录"),
  t("微信账号登录"),
  t("Google 登录"),
  t("GitHub 登录"),
];
void _I18N_PROVIDER_LABEL_KEYS;

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
  const t = useT();
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
              aria-label={t("关闭")}
            >
              <X className="h-5 w-5" />
            </button>

            {/* Header — 标题 + 副标题（按设计稿不展示 Logo） */}
            <div className="flex w-full flex-col items-center px-9 pt-10">
              <h2
                className="text-[28px] font-medium leading-none"
                style={{ color: "rgba(0,0,0,0.9)" }}
              >
                {t("登录")}
              </h2>
              <p
                className="mt-4 text-sm"
                style={{ color: "rgba(0,0,0,0.5)" }}
              >
                {t("使用社交软件一键登录")}
              </p>
            </div>

            {/* OAuth Login buttons — 放在 radio 上方
             *   - 国际站：Google / GitHub（由 VISIBLE_OAUTH_PROVIDERS 决定）
             *   - 国内站：QQ / 微信；且支持通过 show_github_login() 彩蛋追加 GitHub 入口 */}
            <div className="flex w-full flex-col gap-4 px-9 pt-8">
              {(() => {
                const providers: OAuthProvider[] = [...VISIBLE_OAUTH_PROVIDERS];
                if (
                  ALLOW_GITHUB_EASTER_EGG &&
                  showGitHubLogin &&
                  !providers.includes("github")
                ) {
                  providers.push("github");
                }
                return providers.map((provider) => {
                  if (!oauthLoginUrls[provider]) return null;
                  const visual = PROVIDER_BUTTON_VISUALS[provider];
                  return (
                    <button
                      key={provider}
                      type="button"
                      onClick={() => handleOAuthLogin(provider)}
                      disabled={!agreed}
                      className={BUTTON_BASE_CLASS}
                      style={visual.style}
                    >
                      {visual.renderIcon()}
                      <span>{t(visual.label)}</span>
                    </button>
                  );
                });
              })()}
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
                  {t("我已阅读并同意")}{" "}
                  <a
                    href="https://cloud.tencent.com/document/product/301/48034"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline"
                    style={{ color: "var(--lw-accent)" }}
                  >
                    {t("《服务协议》")}
                  </a>{" "}
                  {t("与")}{" "}
                  {isGlobal ? (
                    <Link
                      to="/privacy-policy"
                      className="font-medium hover:underline"
                      style={{ color: "var(--lw-accent)" }}
                    >
                      {t("《隐私保护协议》")}
                    </Link>
                  ) : (
                    <a
                      href="https://cloud.tencent.com/document/product/301/11470"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:underline"
                      style={{ color: "var(--lw-accent)" }}
                    >
                      {t("《隐私保护协议》")}
                    </a>
                  )}
                  {isGlobal ? (
                    <>
                      {" "}
                      {t("与")}{" "}
                      <Link
                        to="/open-source-licenses"
                        className="font-medium hover:underline"
                        style={{ color: "var(--lw-accent)" }}
                      >
                        {t("《开源声明》")}
                      </Link>
                    </>
                  ) : null}
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
                    {t("请先勾选同意服务协议")}
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
  const t = useT();
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const code = inviteCode.trim().toUpperCase();
    if (!code) {
      setError(t("请输入邀请码。"));
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
      setError(e instanceof Error ? e.message : t("邀请码校验失败，请稍后重试。"));
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
                {t("输入邀请码")}
              </h2>
              <p className="mt-1 text-center text-sm text-[var(--text-tertiary)]">
                {t("创建 Hermes 需要先输入邀请码激活权限")}
              </p>
            </div>

            {/* Invite code input */}
            <div className="flex w-full flex-col gap-3 px-8 pb-4 pt-4">
              <input
                type="text"
                autoComplete="one-time-code"
                placeholder={t("请输入邀请码")}
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
                {loading ? t("验证中...") : t("确认")}
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
