import { describe, expect, it } from "vitest";

import { oauthErrorMessage } from "@/pages/marketing/landing-page";

describe("oauthErrorMessage", () => {
  it("maps QQ signin failures to the modal error copy", () => {
    expect(oauthErrorMessage("qq_sign_in_failed")).toBe("QQ 登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("qq_exchange_failed")).toBe("QQ 登录暂时失败，请稍后重试。");
    expect(oauthErrorMessage("qq_identity_failed")).toBe("QQ 登录暂时失败，请稍后重试。");
  });

  it("maps invite and state errors to the landing-page modal copy", () => {
    expect(oauthErrorMessage("invite_required")).toBe("首次使用需要先通过邀请码校验。");
    expect(oauthErrorMessage("qq_state_mismatch")).toBe("登录态已过期，请重新发起 QQ 登录。");
    expect(oauthErrorMessage(null)).toBeNull();
  });
});
