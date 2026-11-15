/**
 * The execution-scoped thread CLI note is delivered through the native agent
 * prompt because ACP has no portable per-input system/developer channel. Native
 * CLIs therefore persist it in their own transcripts. This module is the single
 * owner of the marker and the strict shape used to remove only that generated
 * note from history projections; user text is never matched fuzzily.
 */
export const THREAD_CLI_INSTRUCTION_OPEN = "[opencraft:thread-cli:v1]";
export const THREAD_CLI_INSTRUCTION_CLOSE = "[/opencraft:thread-cli:v1]";

const BODY_PREFIX = "OpenCraft execution-scoped thread CLI: '";
const BODY_SUFFIX = "'. Use this exact executable in place of opencraft for thread commands. It is authorized only for this input and its initiating person. A conversation reference does not grant access. This launcher uses a loopback connection; if your Agent sandbox blocks it, request approval through its existing permission flow. Read referenced history with thread output; follow history.nextCursor with --cursor when needed.";

export function executionCliInstructionBody(launcher: string): string {
  return `${BODY_PREFIX}${launcher.replace(/'/gu, "'\\''")}${BODY_SUFFIX}`;
}

export function executionCliInstructionText(launcher: string): string {
  return `${THREAD_CLI_INSTRUCTION_OPEN}\n${executionCliInstructionBody(launcher)}\n${THREAD_CLI_INSTRUCTION_CLOSE}`;
}

/** True only for the complete generated body, including the exact fixed
 * instruction text. A launcher path is the only variable part. */
function isInstructionBody(value: string): boolean {
  if (!value.startsWith(BODY_PREFIX) || !value.endsWith(BODY_SUFFIX)) return false;
  const launcher = value.slice(BODY_PREFIX.length, value.length - BODY_SUFFIX.length);
  return launcher.length > 0 && launcher.startsWith("/") && !/[\x00-\x1f]/u.test(launcher);
}

/**
 * Remove the generated note from one native text value. Handles:
 * - the current marked block,
 * - a marker followed by the note as an inline suffix (CLIs that join blocks),
 * - the pre-marker note persisted by earlier OpenCraft versions.
 *
 * Returns the value unchanged unless the complete generated note is present, so
 * ordinary user messages that merely quote a prefix are preserved.
 */
export function stripExecutionCliInstruction(value: string): string {
  if (!value) return value;
  const current = `${THREAD_CLI_INSTRUCTION_OPEN}\n`, close = `\n${THREAD_CLI_INSTRUCTION_CLOSE}`;
  if (value.startsWith(current) && value.endsWith(close)
    && isInstructionBody(value.slice(current.length, value.length - close.length))) return "";
  const mark = `\n${current}`;
  const index = value.lastIndexOf(mark);
  if (index >= 0 && value.endsWith(close)
    && isInstructionBody(value.slice(index + mark.length, value.length - close.length))) return value.slice(0, index);
  if (isInstructionBody(value)) return "";
  const legacyMark = `\n${BODY_PREFIX}`;
  const legacy = value.lastIndexOf(legacyMark);
  if (legacy >= 0) {
    const body = value.slice(legacy + 1);
    if (isInstructionBody(body)) return value.slice(0, legacy);
  }
  return value;
}

/** Remove the note from one content block, returning null when the block was
 * only the generated note and should disappear from the projection. */
export function threadCliFreeText(value: string): string | null {
  const stripped = stripExecutionCliInstruction(value);
  return stripped.trim() ? stripped : null;
}

/** Native labels are stored after a 160-200 character truncation, so an old
 * generated note may be incomplete. Labels never carry user content beyond the
 * first user input; remove only a generated prefix at a line boundary. */
export function threadCliLabel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const exact = threadCliFreeText(value);
  if (exact === null) return null;
  if (exact !== value) return exact;
  const currentLine = `${THREAD_CLI_INSTRUCTION_OPEN}\n`;
  if (exact.startsWith(currentLine)) return "";
  const tagged = `\n${currentLine}`, taggedIndex = exact.lastIndexOf(tagged);
  if (taggedIndex > 0 && exact.slice(taggedIndex + tagged.length).startsWith(BODY_PREFIX)) return exact.slice(0, taggedIndex);
  if (exact.startsWith(BODY_PREFIX)) return "";
  const legacy = `\n${BODY_PREFIX}`, legacyIndex = exact.lastIndexOf(legacy);
  if (legacyIndex > 0 && exact.slice(legacyIndex + 1).startsWith(`${BODY_PREFIX}/`)) return exact.slice(0, legacyIndex);
  return value;
}
