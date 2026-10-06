import type { AccountOverviewModel, AccountRegion } from "./index";

export interface AccountDisplaySnapshot {
  readonly version: 1;
  readonly region: AccountRegion;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly updatedAt: number;
}

export const ACCOUNT_DISPLAY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function projectAccountDisplay(model: AccountOverviewModel, region: AccountRegion, now: number): AccountDisplaySnapshot {
  return {
    version: 1,
    region,
    displayName: model.displayName,
    avatarUrl: model.avatarUrl?.startsWith("https://") ? model.avatarUrl : null,
    updatedAt: now,
  };
}

export function parseAccountDisplay(value: unknown, region: AccountRegion, now: number): AccountDisplaySnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Partial<AccountDisplaySnapshot>;
  if (entry.version !== 1 || entry.region !== region
    || typeof entry.displayName !== "string" || !entry.displayName
    || typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)
    || entry.updatedAt > now || now - entry.updatedAt > ACCOUNT_DISPLAY_MAX_AGE_MS
    || (entry.avatarUrl !== null && (typeof entry.avatarUrl !== "string" || !entry.avatarUrl.startsWith("https://")))) return null;
  return entry as AccountDisplaySnapshot;
}
