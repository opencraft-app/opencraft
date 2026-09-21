export interface AuthShadowBinding {
  userId: string;
  shadowUserName: string;
  uin: number;
  ownerUin: number;
  appId: number;
  status: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  basicAuthStatus?: string;
  basicAuthSyncedAt?: string;
  basicAuthLastErrorCode?: string;
  basicAuthLastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthShadowBindingFormInput {
  userId: string;
  shadowUserName: string;
  uin: string;
  ownerUin: string;
  appId: string;
  reason: string;
}

export interface AuthShadowBindingRequest {
  userId: string;
  shadowUserName: string;
  uin: number;
  ownerUin: number;
  appId: number;
  reason: string;
}

export function authShadowBindingPath(userId: string): string {
  return `auth/shadow-bindings/${encodeURIComponent(userId.trim())}`;
}

export function buildAuthShadowBindingRequest(input: AuthShadowBindingFormInput): AuthShadowBindingRequest {
  const userId = requiredText(input.userId, "userId");
  const shadowUserName = requiredText(input.shadowUserName, "shadowUserName");
  const reason = requiredText(input.reason, "reason");
  return {
    userId,
    shadowUserName,
    uin: positiveSafeInteger(input.uin, "uin"),
    ownerUin: positiveSafeInteger(input.ownerUin, "ownerUin"),
    appId: positiveSafeInteger(input.appId, "appId"),
    reason,
  };
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function positiveSafeInteger(value: string, field: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}
