/** Values are observations, not billing authority. Missing counters remain unknown. */
export const USAGE_FIELDS = Object.freeze([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "estimatedCostUsd",
]);
export function normalizeUsage(raw) {
  const finite = (n) =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  return Object.fromEntries(
    USAGE_FIELDS.map((key) => [
      key,
      finite(
        key === "estimatedCostUsd"
          ? raw?.cost?.total
          : Number.isSafeInteger(raw?.[key])
            ? raw[key]
            : undefined,
      ),
    ]),
  );
}
export function sumUsage(rows) {
  return Object.fromEntries(
    USAGE_FIELDS.map((key) => [
      key,
      rows.length && rows.every((r) => r[key] !== null)
        ? rows.reduce((n, r) => n + r[key], 0)
        : null,
    ]),
  );
}
