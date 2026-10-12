/** Recognition only: not an installation/resource authorization grant. */
export interface TencentOaIdentity {
  readonly loginName: string;
  readonly staffId: string;
  readonly expiresAt: string;
}
export interface TencentOaSessionResponse {
  readonly available: boolean;
  readonly identity: TencentOaIdentity | null;
}
export const TENCENTOA_SESSION_PATH = "/__opencraft_tencentoa/session";
export const TENCENTOA_PHOTO_PATH = "/__opencraft_tencentoa/photo/";
export const TENCENTOA_PROVIDER_ID = "tencentoa.identity.employee";
/** TAI's documented clock-skew grace, shared by server and client. */
export const TENCENTOA_CLOCK_SKEW_MS = 180_000;
export function identityValidUntil(identity: TencentOaIdentity): number {
  return Date.parse(identity.expiresAt) + TENCENTOA_CLOCK_SKEW_MS;
}
