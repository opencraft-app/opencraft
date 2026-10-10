export type AccountRegion = "cn" | "intl";
export const ACCOUNT_UPDATED_EVENT = "opencraft:account-updated";

export const ACCOUNT_NICKNAME_MAX_LENGTH = 20;
export const ACCOUNT_AVATAR_UPLOAD_MAX_BYTES = 800 * 1024;
export const normalizeAccountNickname = (value: string) => value.trim();
export const isValidAccountNickname = (value: string) => {
  const length = Array.from(normalizeAccountNickname(value)).length;
  return length > 0 && length <= ACCOUNT_NICKNAME_MAX_LENGTH;
};
export const normalizeSafetyPhone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
};
export const isValidSafetyPhone = (value: string) => /^1\d{10}$/.test(normalizeSafetyPhone(value));

/** Endpoint and payload ownership lives here; hosts supply session transport. */
export const accountOperations = {
  updateNickname(name: string) {
    return { path: "/auth/profile", method: "PUT" as const, body: { name: normalizeAccountNickname(name) } };
  },
  sendPhoneCode(phone: string) {
    return { path: "/auth/profile/phone/send", method: "POST" as const, body: { phone: normalizeSafetyPhone(phone) } };
  },
  verifyPhone(phone: string, code: string) {
    return { path: "/auth/profile/phone/verify", method: "POST" as const, body: { phone: normalizeSafetyPhone(phone), code: code.trim() } };
  },
  uploadAvatar() {
    return { path: "/auth/profile/avatar", method: "PUT" as const, field: "file" as const };
  },
  signOut() {
    return { path: "/auth/session", method: "DELETE" as const };
  },
};

export function parsePhoneCodeResponse(value: unknown): { readonly cooldownSeconds: number } {
  if (typeof value !== "object" || value === null) throw new Error("Invalid phone code response");
  const seconds = (value as { cooldownSeconds?: unknown }).cooldownSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid phone code response");
  return { cooldownSeconds: seconds };
}

export interface AccountProfileSource {
  readonly id: string;
  readonly name: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly avatarUrl?: string | null;
  readonly pendingName?: string | null;
  readonly nameAuditStatus?: "pending" | "passed" | "failed" | null;
  readonly pendingAvatarUrl?: string | null;
  readonly avatarAuditStatus?: "pending" | "passed" | "failed" | null;
  readonly realnameVerified?: boolean | null;
  readonly realnameLevel?: string | null;
  readonly realnameAssuranceMode?: "legacy" | "faceless" | "observe" | "face_required" | null;
  readonly realnameSyncStatus?: "pending" | "failed" | "succeeded" | null;
}

export interface AccountOverviewModel {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly avatarUrl: string | null;
  readonly namePending: boolean;
  readonly avatarPending: boolean;
  readonly verification: "verified" | "needs-review" | "syncing" | "sync-failed" | "unverified" | "not-applicable";
}

export function deriveAccountVerification(source: Pick<AccountProfileSource, "realnameVerified" | "realnameLevel" | "realnameAssuranceMode" | "realnameSyncStatus"> | null | undefined, phoneVerificationEnabled: boolean) {
  const faceFlow = source?.realnameAssuranceMode === "observe"
    || source?.realnameAssuranceMode === "face_required"
    || source?.realnameAssuranceMode === "faceless";
  const verified = faceFlow
    ? source?.realnameVerified === true && source?.realnameLevel === "phone_3fa"
    : phoneVerificationEnabled
      ? source?.realnameLevel === "phone_3fa"
      : source?.realnameVerified === true;
  const idCardVerified = faceFlow
    ? !verified && (source?.realnameLevel === "idcard_2fa" || source?.realnameLevel === "phone_3fa")
    : phoneVerificationEnabled && (source?.realnameLevel === "idcard_2fa" || source?.realnameLevel === "phone_3fa");
  const shadowProofReady = faceFlow && idCardVerified && source?.realnameLevel === "phone_3fa";
  const idCardSyncStatus = faceFlow
    ? shadowProofReady ? source?.realnameSyncStatus : undefined
    : idCardVerified && !verified ? source?.realnameSyncStatus : undefined;
  return { verified, idCardVerified, shadowProofReady, idCardSyncStatus };
}

/** The profile endpoint is a trust boundary for the native host. */
export function parseAccountProfile(value: unknown): AccountProfileSource {
  if (typeof value !== "object" || value === null) throw new Error("Invalid account profile");
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string") throw new Error("Invalid account profile");
  const optional = (key: string) => typeof raw[key] === "string" ? raw[key] as string : null;
  return {
    id: raw.id,
    name: raw.name,
    email: optional("email"),
    phone: optional("phone"),
    avatarUrl: optional("avatarUrl"),
    pendingName: optional("pendingName"),
    pendingAvatarUrl: optional("pendingAvatarUrl"),
    nameAuditStatus: raw.nameAuditStatus === "pending" || raw.nameAuditStatus === "passed" || raw.nameAuditStatus === "failed" ? raw.nameAuditStatus : null,
    avatarAuditStatus: raw.avatarAuditStatus === "pending" || raw.avatarAuditStatus === "passed" || raw.avatarAuditStatus === "failed" ? raw.avatarAuditStatus : null,
    realnameVerified: raw.realnameVerified === true,
    realnameLevel: optional("realnameLevel"),
    realnameAssuranceMode: raw.realnameAssuranceMode === "legacy" || raw.realnameAssuranceMode === "faceless" || raw.realnameAssuranceMode === "observe" || raw.realnameAssuranceMode === "face_required" ? raw.realnameAssuranceMode : null,
    realnameSyncStatus: raw.realnameSyncStatus === "pending" || raw.realnameSyncStatus === "failed" || raw.realnameSyncStatus === "succeeded" ? raw.realnameSyncStatus : null,
  };
}

/** Keep account status semantics outside both renderers. The backend remains authoritative. */
export function projectAccountOverview(source: AccountProfileSource, region: AccountRegion, phoneProofEnabled: boolean): AccountOverviewModel {
  const { verified, idCardVerified, idCardSyncStatus } = deriveAccountVerification(source, phoneProofEnabled);
  const verification = region === "intl" ? "not-applicable"
    : verified ? "verified"
      : idCardVerified && idCardSyncStatus === "failed" ? "sync-failed"
        : idCardVerified && idCardSyncStatus === "pending" ? "syncing"
          : idCardVerified ? "needs-review" : "unverified";
  const namePending = source.nameAuditStatus === "pending" && Boolean(source.pendingName?.trim());
  const avatarPending = source.avatarAuditStatus === "pending" && Boolean(source.pendingAvatarUrl);
  return {
    id: source.id,
    displayName: namePending ? source.pendingName!.trim() : source.name.trim() || source.id,
    email: source.email?.trim() || null,
    phone: source.phone?.trim() || null,
    avatarUrl: avatarPending ? source.pendingAvatarUrl! : source.avatarUrl || null,
    namePending,
    avatarPending,
    verification,
  };
}

export interface ReferralOverview {
  readonly code: string;
  readonly url: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface ReferralStats {
  readonly successfulReferrals: number;
  readonly grantedCredits: number;
  readonly pendingRewards: number;
  readonly grantedRewards: number;
}

/** Map the referral API's snake_case payload for both the site and the App. */
export function parseReferralOverview(value: unknown): ReferralOverview {
  if (typeof value !== "object" || value === null) throw new Error("Invalid referral overview");
  const raw = value as Record<string, unknown>;
  const fields = ["code", "url", "campaign_id", "campaign_name", "starts_at", "ends_at"] as const;
  if (fields.some(field => typeof raw[field] !== "string")) throw new Error("Invalid referral overview");
  const url = raw.url as string;
  return {
    code: raw.code as string,
    url,
    campaignId: raw.campaign_id as string,
    campaignName: raw.campaign_name as string,
    startsAt: raw.starts_at as string,
    endsAt: raw.ends_at as string,
  };
}

export function parseReferralStats(value: unknown): ReferralStats {
  if (typeof value !== "object" || value === null) throw new Error("Invalid referral stats");
  const raw = value as Record<string, unknown>;
  const fields = ["successful_referrals", "granted_credits", "pending_rewards", "granted_rewards"] as const;
  if (fields.some(field => typeof raw[field] !== "number" || !Number.isFinite(raw[field]) || (raw[field] as number) < 0)) {
    throw new Error("Invalid referral stats");
  }
  return {
    successfulReferrals: raw.successful_referrals as number,
    grantedCredits: raw.granted_credits as number,
    pendingRewards: raw.pending_rewards as number,
    grantedRewards: raw.granted_rewards as number,
  };
}
