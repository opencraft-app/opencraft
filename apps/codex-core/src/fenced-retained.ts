import type { CodexAccountRetainedState } from "@opencraft/account-pool-host";

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validate a full offline export without starting services or touching storage.
 * Bounds and shapes match the three source retained-state restoration contracts.
 * No missing array means empty; no pending outcome becomes a terminal receipt.
 */
export function parseFencedRetained(value: unknown): CodexAccountRetainedState {
  if (!record(value) || Object.keys(value).sort().join(",") !== "imageAffinities,loginReceipts,resetReceipts"
    || !Array.isArray(value.imageAffinities) || value.imageAffinities.length > 8192
    || !Array.isArray(value.loginReceipts) || value.loginReceipts.length > 128
    || !Array.isArray(value.resetReceipts) || value.resetReceipts.length > 1024) throw new Error("Incomplete account retained export");
  const images = new Set<string>(), logins = new Set<string>(), resets = new Set<string>();
  for (const tuple of value.imageAffinities) {
    if (!Array.isArray(tuple) || tuple.length !== 2) throw new Error("Invalid exported image tuple");
    const [key, row] = tuple;
    if (typeof key !== "string" || key.length > 2048 || images.has(key) || !record(row)
      || typeof row.affinityId !== "string" || row.affinityId.length > 512
      || !Number.isSafeInteger(row.expiresAt)) throw new Error("Invalid exported image affinity");
    images.add(key);
  }
  for (const tuple of value.loginReceipts) {
    if (!Array.isArray(tuple) || tuple.length !== 2) throw new Error("Invalid exported login tuple");
    const [id, row] = tuple;
    if (typeof id !== "string" || logins.has(id) || !record(row) || !Number.isSafeInteger(row.expiresAt)
      || !record(row.result) || !["error", "complete"].includes(row.result.status)) throw new Error("Invalid exported login receipt");
    logins.add(id);
  }
  for (const row of value.resetReceipts) {
    if (!record(row) || typeof row.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/u.test(row.idempotencyKey)
      || resets.has(row.idempotencyKey) || [row.accountId, row.creditId].some(v => typeof v !== "string" || !v.trim() || v.length > 512)
      || !["unknown", "reset", "nothingToReset", "noCredit", "alreadyRedeemed"].includes(row.outcome)) throw new Error("Invalid exported reset receipt");
    resets.add(row.idempotencyKey);
  }
  return value as unknown as CodexAccountRetainedState;
}
