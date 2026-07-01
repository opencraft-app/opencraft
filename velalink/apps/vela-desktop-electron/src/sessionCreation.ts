export function normalizeInitialSessionMessage(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
