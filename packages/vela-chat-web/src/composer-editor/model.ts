import type { ComposerEditorCursor, ComposerEditorSnapshot } from "./types";

export function clampComposerOffset(value: string, offset: number): number {
  if (!Number.isFinite(offset)) return value.length;
  return Math.max(0, Math.min(value.length, Math.trunc(offset)));
}

export function normalizeComposerCursor(
  value: string,
  cursor: ComposerEditorCursor | null | undefined,
): ComposerEditorCursor | null {
  if (!cursor) return null;
  return {
    start: clampComposerOffset(value, cursor.start),
    end: clampComposerOffset(value, cursor.end),
  };
}

export function hasComposerLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

export function normalizeComposerSingleLine(value: string): string {
  return value.replace(/\r\n?|\n/g, " ");
}

export function createComposerEditorSnapshot({
  value,
  cursor,
}: {
  value: string;
  cursor?: ComposerEditorCursor | null;
}): ComposerEditorSnapshot {
  const normalizedCursor = normalizeComposerCursor(value, cursor);
  return {
    value,
    cursor: normalizedCursor,
    expandedCursor: normalizedCursor,
    tokenIds: [],
  };
}
