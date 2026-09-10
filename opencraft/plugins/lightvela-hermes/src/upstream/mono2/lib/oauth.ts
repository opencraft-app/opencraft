// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { isGlobal } from "./region";

export type OAuthProvider = "qq" | "wechat" | "google" | "github";
export type WeChatOAuthMode = "website" | "official_account";
export type WeChatOAuthStartTarget = WeChatOAuthMode | "unsupported_mobile_browser";

/**
 * 当前区域允许展示的 OAuth 登录渠道（编译期常量）。
 * - 国内站：QQ / 微信（GitHub 彩蛋走 useGitHubLoginVisibility 动态开启）
 * - 国际站：Google / GitHub
 *
 * 数组顺序即登录页渲染顺序，修改前请确认设计稿。
 */
export const VISIBLE_OAUTH_PROVIDERS: readonly OAuthProvider[] = isGlobal
  ? (["google", "github"] as const)
  : (["qq", "wechat"] as const);

/** GitHub 彩蛋入口是否允许在国内站通过 show_github_login() 显示 */
export const ALLOW_GITHUB_EASTER_EGG = !isGlobal;

const OAUTH_PROVIDER_LABEL: Record<OAuthProvider, string> = {
  qq: "QQ",
  wechat: "微信",
  google: "Google",
  github: "GitHub",
};

const OAUTH_PROVIDER_FAILURE_MESSAGES: Record<OAuthProvider, string> = {
  qq: "QQ 登录暂时失败，请稍后重试。",
  wechat: "微信登录暂时失败，请稍后重试。",
  google: "Google 登录暂时失败，请稍后重试。",
  github: "GitHub 登录暂时失败，请稍后重试。",
};

const OAUTH_PROVIDER_STATE_MESSAGES: Record<OAuthProvider, string> = {
  qq: "登录态已过期，请重新发起 QQ 登录。",
  wechat: "登录态已过期，请重新发起微信登录。",
  google: "登录态已过期，请重新发起 Google 登录。",
  github: "登录态已过期，请重新发起 GitHub 登录。",
};

const OAUTH_FAILURE_CODES = new Set(["exchange_failed", "identity_failed", "sign_in_failed"]);

export const oauthProviderLabel = (provider: OAuthProvider) => OAUTH_PROVIDER_LABEL[provider];

export const redirectToOAuthStart = (url: string) => {
  window.location.assign(url);
};

export const wechatOAuthStartTargetForUserAgent = (userAgent: string): WeChatOAuthStartTarget => {
  const normalized = userAgent.toLowerCase();
  if (normalized.includes("micromessenger")) {
    return "official_account";
  }
  if (/android|iphone|ipad|ipod|mobile|windows phone/.test(normalized)) {
    return "unsupported_mobile_browser";
  }
  return "website";
};

export const oauthErrorMessage = (oauthError: string | null) => {
  if (!oauthError) {
    return null;
  }

  if (oauthError === "github_registration_disabled") {
    return "GitHub registration is unavailable. Please sign in with Google.";
  }
  if (oauthError === "github_email_suffix_blocked") {
    return "This email domain is not supported for registration. Please use another email.";
  }
  if (oauthError === "github_email_required") {
    return "GitHub needs a verified email to register. Please add or verify your primary email on GitHub, then try again.";
  }
  if (oauthError === "qq_registration_disabled") {
    return "QQ 暂不开放新用户注册，请使用微信登录。";
  }

  for (const provider of ["qq", "wechat", "google", "github"] as const) {
    if (oauthError === `${provider}_state_mismatch`) {
      return OAUTH_PROVIDER_STATE_MESSAGES[provider];
    }
    for (const code of OAUTH_FAILURE_CODES) {
      if (oauthError === `${provider}_${code}`) {
        return OAUTH_PROVIDER_FAILURE_MESSAGES[provider];
      }
    }
  }

  return null;
};
