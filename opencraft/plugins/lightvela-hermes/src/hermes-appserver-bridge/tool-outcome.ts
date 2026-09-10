/** Execution evidence shared by live and durable projections. Unknown is not success. */
export function toolOutcome(value: unknown): boolean | null {
  if (typeof value === "string") {
    try { return toolOutcome(JSON.parse(value)); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (result.error != null || result.isError === true || result.success === false) return false;
  if (typeof result.exit_code === "number") return result.exit_code === 0;
  return result.success === true ? true : null;
}
