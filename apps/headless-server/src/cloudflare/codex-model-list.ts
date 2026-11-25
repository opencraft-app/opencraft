import type { ModelListParams } from "@opencraft/appserver-protocol";

export const CODEX_MODEL_LIST_PATH = "/__opencraft_internal/codex-model-list";

export function parseCodexModelList(value: unknown): ModelListParams | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { cursor, limit, includeHidden } = value as Partial<ModelListParams>;
  if (
    Object.keys(value).some((key) => !["cursor", "limit", "includeHidden"].includes(key)) ||
    (cursor != null && (typeof cursor !== "string" || cursor.length > 4096 || /[\x00-\x1f\x7f]/u.test(cursor))) ||
    (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) ||
    (includeHidden != null && typeof includeHidden !== "boolean")
  )
    return null;
  return { cursor, limit, includeHidden };
}

export function isCodexModelList(
  value: unknown,
): value is { data: Array<{ model: string }>; nextCursor: string | null } {
  const result = value as { data?: unknown; nextCursor?: unknown } | null;
  return (
    Array.isArray(result?.data) &&
    result.data.every((entry) => typeof entry?.model === "string") &&
    (result.nextCursor === null || (typeof result.nextCursor === "string" && result.nextCursor.length <= 4096))
  );
}
