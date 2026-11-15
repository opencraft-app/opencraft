/** Source-owned display grouping, separate from an OpenCraft execution Project. */
export type NativeConversationProject = {
  readonly source: "codex";
  readonly id: string;
  readonly name: string;
  readonly position: number;
};
export function parseNativeConversationProject(value: unknown): NativeConversationProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.source !== "codex" || typeof row.id !== "string" || !row.id || row.id.length > 512
    || typeof row.name !== "string" || !row.name.trim() || row.name.length > 256
    || !Number.isSafeInteger(row.position) || Number(row.position) < 0) return null;
  return { source: "codex", id: row.id, name: row.name, position: Number(row.position) };
}
