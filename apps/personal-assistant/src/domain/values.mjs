import { createHash } from "node:crypto";

export const stable = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : stable(value))
    .digest("hex");
export function requireText(value, name, max = 20000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name} must contain 1..${max} characters`);
  return value;
}
export function epochTime(value, name) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be an epoch millisecond integer`);
  return value;
}
export function requireRevision(expected, actual, label) {
  if (expected !== undefined && expected !== actual)
    throw new Error(`Stale ${label} revision`);
}
