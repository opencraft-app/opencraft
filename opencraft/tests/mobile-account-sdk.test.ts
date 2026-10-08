import assert from "node:assert/strict";
import test from "node:test";
import { accountOperations, deriveAccountVerification, isValidAccountNickname, isValidSafetyPhone, normalizeSafetyPhone, parseAccountProfile, parsePhoneCodeResponse, parseReferralOverview, parseReferralStats, projectAccountOverview } from "@opencraft/mobile-account-sdk";
import { ACCOUNT_DISPLAY_MAX_AGE_MS, parseAccountDisplay, projectAccountDisplay } from "@opencraft/mobile-account-sdk/display-cache";

test("display cache contains only display fields and expires before another region can use it", () => {
  const now = Date.now();
  const profile = projectAccountOverview({ id: "u1", name: "Alice", email: "private@example.com", phone: "13800138000", avatarUrl: "https://cdn.example.test/avatar.png", realnameVerified: true }, "cn", false);
  const saved = projectAccountDisplay(profile, "cn", now);
  assert.deepEqual(Object.keys(saved).sort(), ["avatarUrl", "displayName", "region", "updatedAt", "version"]);
  assert.equal(parseAccountDisplay(saved, "cn", now)?.displayName, "Alice");
  assert.equal(parseAccountDisplay(saved, "intl", now), null);
  assert.equal(parseAccountDisplay(saved, "cn", now + ACCOUNT_DISPLAY_MAX_AGE_MS + 1), null);
  assert.equal(parseAccountDisplay({ ...saved, avatarUrl: "file:///private/avatar.png" }, "cn", now), null);
});

test("account profile rejects malformed auth responses", () => {
  assert.throws(() => parseAccountProfile({ user: { id: "x" } }), /Invalid account profile/);
  assert.deepEqual(parseAccountProfile({ id: "u1", name: "Alice", realnameLevel: "phone_3fa", realnameVerified: true }), {
    id: "u1", name: "Alice", email: null, phone: null, avatarUrl: null,
    pendingName: null, pendingAvatarUrl: null, nameAuditStatus: null, avatarAuditStatus: null,
    realnameVerified: true, realnameLevel: "phone_3fa", realnameAssuranceMode: null, realnameSyncStatus: null,
  });
});

test("the shared projection handles name audit and domestic verification without leaking it into the international view", () => {
  const source = {
    id: "u1", name: "Old name", pendingName: "New name", nameAuditStatus: "pending" as const,
    realnameLevel: "idcard_2fa", realnameVerified: false, realnameSyncStatus: "failed" as const,
  };
  assert.equal(projectAccountOverview(source, "cn", true).displayName, "New name");
  assert.equal(projectAccountOverview(source, "cn", true).verification, "sync-failed");
  assert.equal(projectAccountOverview(source, "intl", false).verification, "not-applicable");
  assert.equal(deriveAccountVerification({ realnameLevel: "phone_3fa", realnameVerified: false }, true).verified, true);
  assert.equal(deriveAccountVerification({ realnameLevel: "phone_3fa", realnameVerified: false, realnameAssuranceMode: "face_required" }, true).verified, false);
});

test("referral API data keeps the same shape on web and native", () => {
  assert.deepEqual(parseReferralOverview({ code: "FRIEND", url: "https://lightvela.com/?ref=FRIEND", campaign_id: "campaign", campaign_name: "Invite", starts_at: "2026-01-01", ends_at: "2026-12-31" }), {
    code: "FRIEND", url: "https://lightvela.com/?ref=FRIEND", campaignId: "campaign", campaignName: "Invite", startsAt: "2026-01-01", endsAt: "2026-12-31",
  });
  assert.deepEqual(parseReferralStats({ successful_referrals: 2, granted_credits: 500, pending_rewards: 1, granted_rewards: 1 }), {
    successfulReferrals: 2, grantedCredits: 500, pendingRewards: 1, grantedRewards: 1,
  });
  assert.throws(() => parseReferralOverview({ url: "missing other fields" }), /Invalid referral/);
});

test("profile and phone operations share endpoint, payload and validation rules", () => {
  assert.deepEqual(accountOperations.updateNickname("  Alice  "), { path: "/auth/profile", method: "PUT", body: { name: "Alice" } });
  assert.deepEqual(accountOperations.sendPhoneCode("138 0013 8000"), { path: "/auth/profile/phone/send", method: "POST", body: { phone: "13800138000" } });
  assert.deepEqual(accountOperations.verifyPhone("13800138000", " 1234 "), { path: "/auth/profile/phone/verify", method: "POST", body: { phone: "13800138000", code: "1234" } });
  assert.deepEqual(accountOperations.uploadAvatar(), { path: "/auth/profile/avatar", method: "PUT", field: "file" });
  assert.deepEqual(accountOperations.signOut(), { path: "/auth/session", method: "DELETE" });
  assert.equal(isValidAccountNickname(" "), false);
  assert.equal(isValidAccountNickname("a".repeat(21)), false);
  assert.equal(isValidSafetyPhone("13800138000"), true);
  assert.equal(isValidSafetyPhone("123"), false);
  assert.equal(isValidSafetyPhone("138001380001"), false);
  assert.equal(normalizeSafetyPhone("+86 138 0013 8000"), "13800138000");
  assert.deepEqual(parsePhoneCodeResponse({ cooldownSeconds: 60 }), { cooldownSeconds: 60 });
});
