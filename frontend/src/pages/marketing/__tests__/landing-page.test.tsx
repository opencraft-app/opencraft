import { describe, expect, it } from "vitest";

import { oauthErrorMessage } from "@/lib/oauth";

describe("oauthErrorMessage", () => {
  it("maps QQ signin failures to the modal error copy", () => {
    expect(oauthErrorMessage("qq_sign_in_failed")).toBe("QQ 登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("qq_exchange_failed")).toBe("QQ 登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("qq_identity_failed")).toBe("QQ 登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("qq_registration_disabled")).toBe("QQ 暂不开放新用户注册，请使用微信登录。");
  });

  it("maps Google signin failures to the modal error copy", () => {
    expect(oauthErrorMessage("google_sign_in_failed")).toBe("Google 登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("google_exchange_failed")).toBe("Google 登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("google_identity_failed")).toBe("Google 登录暂时失败，请稍后重试。");
  });

  it("maps GitHub signin failures to the modal error copy", () => {
    expect(oauthErrorMessage("github_sign_in_failed")).toBe("GitHub 登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("github_exchange_failed")).toBe("GitHub 登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("github_identity_failed")).toBe("GitHub 登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("github_registration_disabled")).toBe(
      "GitHub registration is unavailable. Please sign in with Google.",
    );
  });

  it("maps WeChat signin failures to the shared modal error copy", () => {
    expect(oauthErrorMessage("wechat_sign_in_failed")).toBe("微信登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("wechat_exchange_failed")).toBe("微信登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("wechat_identity_failed")).toBe("微信登录暂时失败，请稍后重试。");
  });

  it("maps state errors to the landing-page modal copy", () => {
    expect(oauthErrorMessage("invite_required")).toBeNull();
    expect(oauthErrorMessage("qq_state_mismatch")).toBe("登录态已过期，请重新发起 QQ 登录。");
    expect(oauthErrorMessage("google_state_mismatch")).toBe("登录态已过期，请重新发起 Google 登录。");
    expect(oauthErrorMessage("github_state_mismatch")).toBe("登录态已过期，请重新发起 GitHub 登录。");
    expect(oauthErrorMessage("wechat_state_mismatch")).toBe("登录态已过期，请重新发起微信登录。");
    expect(oauthErrorMessage(null)).toBeNull();
  });
});
