export type OAuthProvider = "qq" | "wechat" | "google" | "github";

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

export const oauthErrorMessage = (oauthError: string | null) => {
  if (!oauthError) {
    return null;
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
