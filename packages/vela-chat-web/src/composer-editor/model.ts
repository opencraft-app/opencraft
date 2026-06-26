import type { ComposerEditorCursor, ComposerEditorSnapshot } from "./types";

export type ComposerInlineSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "skill";
      name: string;
      prefix: "$" | "/";
      text: string;
    };

export interface ComposerInlineOptions {
  skillNames?: readonly string[];
}

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

function skillNameSet(options: ComposerInlineOptions | undefined) {
  if (!options?.skillNames) return null;
  return new Set(options.skillNames.map((name) => name.trim()).filter(Boolean));
}

function pushTextSegment(segments: ComposerInlineSegment[], text: string) {
  if (!text) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

export function splitComposerInlineSegments(
  value: string,
  options?: ComposerInlineOptions,
): ComposerInlineSegment[] {
  const names = skillNameSet(options);
  if (!value) return [];

  const segments: ComposerInlineSegment[] = [];
  let cursor = 0;
  const tokenPattern = /(^|\s)([$/])([A-Za-z][A-Za-z0-9_.:-]*)(?=\s|$)/g;

  for (const match of value.matchAll(tokenPattern)) {
    const fullMatch = match[0];
    const leading = match[1] ?? "";
    const prefix = match[2] as "$" | "/";
    const name = match[3] ?? "";
    const matchIndex = match.index ?? 0;
    const start = matchIndex + leading.length;
    const end = matchIndex + fullMatch.length;
    if (!name || (names && !names.has(name))) continue;

    pushTextSegment(segments, value.slice(cursor, start));
    const text = `${prefix}${name}`;
    segments.push({ type: "skill", name, prefix, text });
    cursor = end;
  }

  pushTextSegment(segments, value.slice(cursor));
  return segments;
}

function collapsedSegmentLength(segment: ComposerInlineSegment) {
  return segment.type === "skill" ? 1 : segment.text.length;
}

function expandedSegmentLength(segment: ComposerInlineSegment) {
  return segment.text.length;
}

export function collapseComposerExpandedCursor(
  value: string,
  cursorInput: number,
  options?: ComposerInlineOptions,
) {
  const cursor = clampComposerOffset(value, cursorInput);
  const segments = splitComposerInlineSegments(value, options);
  let remaining = cursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    const expandedLength = expandedSegmentLength(segment);
    if (remaining === 0) return collapsedCursor;
    if (remaining <= expandedLength) {
      if (segment.type === "skill") return collapsedCursor + 1;
      return collapsedCursor + remaining;
    }
    remaining -= expandedLength;
    collapsedCursor += collapsedSegmentLength(segment);
  }

  return collapsedCursor;
}

export function expandComposerCollapsedCursor(
  value: string,
  cursorInput: number,
  options?: ComposerInlineOptions,
) {
  const segments = splitComposerInlineSegments(value, options);
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  const cursor = Number.isFinite(cursorInput)
    ? Math.max(0, Math.min(collapsedLength, Math.trunc(cursorInput)))
    : collapsedLength;
  let remaining = cursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    const collapsedLengthForSegment = collapsedSegmentLength(segment);
    if (remaining === 0) return expandedCursor;
    if (remaining <= collapsedLengthForSegment) {
      if (segment.type === "skill") return expandedCursor + segment.text.length;
      return expandedCursor + remaining;
    }
    remaining -= collapsedLengthForSegment;
    expandedCursor += expandedSegmentLength(segment);
  }

  return expandedCursor;
}

export function createComposerEditorSnapshot({
  value,
  cursor,
  expandedCursor,
}: {
  value: string;
  cursor?: ComposerEditorCursor | null;
  expandedCursor?: ComposerEditorCursor | null;
}): ComposerEditorSnapshot {
  const normalizedCursor = normalizeComposerCursor(value, cursor);
  return {
    value,
    cursor: normalizedCursor,
    expandedCursor: normalizeComposerCursor(value, expandedCursor ?? normalizedCursor),
    tokenIds: [],
  };
}
