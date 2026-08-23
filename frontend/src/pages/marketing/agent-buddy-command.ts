import type { BotRepository } from "@/repositories/types";
import {
  isExecCommandSucceeded,
  truncateExecOutput,
} from "@/pages/marketing/agent-reset-config";
import { PERSONA_MARKDOWN_MAX_BYTES } from "@/pages/marketing/agent-persona-upload";

export const HERMES_PERSONA_COMMAND_TIMEOUT_MS = 120_000;
export const HERMES_PERSONA_COMMAND_MAX_BYTES = 32 * 1024;

const HERMES_ROOT_COMMAND = 'HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"';

export function buildHermesSoulWriteCommand(
  markdownBase64: string,
  timestamp: string,
): string {
  const command = [
    "set -eo pipefail",
    HERMES_ROOT_COMMAND,
    'BACKUP_DIR="$HERMES_ROOT/.soul-backups"',
    'mkdir -p "$HERMES_ROOT" "$BACKUP_DIR"',
    'TARGET="$HERMES_ROOT/SOUL.md"',
    `BACKUP="$BACKUP_DIR/${timestamp}.md"`,
    'if [ -s "$TARGET" ]; then cp "$TARGET" "$BACKUP"; fi',
    'TEMP="$(mktemp "$HERMES_ROOT/.SOUL.md.tmp.XXXXXX")"',
    "trap 'rm -f \"$TEMP\"' EXIT",
    "cat <<'__CTL_SOUL_EOF__' | base64 -d > \"$TEMP\"",
    markdownBase64,
    "__CTL_SOUL_EOF__",
    'test -s "$TEMP"',
    'mv "$TEMP" "$TARGET"',
    "trap - EXIT",
  ].join("\n");
  if (new TextEncoder().encode(command).byteLength >= HERMES_PERSONA_COMMAND_MAX_BYTES) {
    throw new Error("Hermes persona command exceeds the 32 KB limit");
  }
  return command;
}

export function buildHermesSoulClearCommand(timestamp: string): string {
  return [
    "set -eo pipefail",
    HERMES_ROOT_COMMAND,
    'BACKUP_DIR="$HERMES_ROOT/.soul-backups"',
    'TARGET="$HERMES_ROOT/SOUL.md"',
    'if [ -s "$TARGET" ]; then',
    '  mkdir -p "$BACKUP_DIR"',
    `  cp "$TARGET" "$BACKUP_DIR/${timestamp}.removed.md"`,
    '  rm -f "$TARGET"',
    "fi",
  ].join("\n");
}

export function buildHermesSoulReadCommand(): string {
  return [
    "set +e",
    HERMES_ROOT_COMMAND,
    'TARGET="$HERMES_ROOT/SOUL.md"',
    'if [ -s "$TARGET" ]; then',
    "  printf '%s\\n' 'Exists: yes'",
    '  grep -m1 "^Slug:" "$TARGET" 2>/dev/null || printf \'%s\\n\' \'Slug:\'',
    '  grep -m1 "^Name:" "$TARGET" 2>/dev/null || printf \'%s\\n\' \'Name:\'',
    "else",
    "  printf '%s\\n' 'Exists: no'",
    "fi",
  ].join("\n");
}

export function buildHermesSoulContentReadCommand(): string {
  return [
    "set +e",
    HERMES_ROOT_COMMAND,
    'TARGET="$HERMES_ROOT/SOUL.md"',
    'if [ ! -s "$TARGET" ]; then',
    "  printf '%s\\n' 'Exists: no'",
    "  exit 0",
    "fi",
    'BYTE_LENGTH="$(wc -c < "$TARGET" | tr -d \'[:space:]\')"',
    "printf '%s\\n' 'Exists: yes'",
    `if [ "$BYTE_LENGTH" -gt ${PERSONA_MARKDOWN_MAX_BYTES} ]; then`,
    "  printf '%s\\n' 'TooLarge: yes'",
    "  printf 'ByteLength: %s\\n' \"$BYTE_LENGTH\"",
    "  exit 0",
    "fi",
    "printf 'ByteLength: %s\\n' \"$BYTE_LENGTH\"",
    'CONTENT_BASE64="$(base64 < "$TARGET" | tr -d \'\\r\\n\')"',
    "printf 'ContentBase64: %s\\n' \"$CONTENT_BASE64\"",
  ].join("\n");
}

export type HermesSoulIdentity = {
  exists: boolean;
  slug: string | null;
  name: string | null;
};

export type HermesSoulContentResult =
  | { status: "ready"; markdown: string; byteLength: number }
  | { status: "missing" }
  | { status: "too_large"; byteLength: number }
  | { status: "invalid" };

export function parseHermesSoulIdentity(output: string): HermesSoulIdentity {
  const lines = output.split(/\r?\n/);
  if (!lines.some((line) => line.trim() === "Exists: yes")) {
    return { exists: false, slug: null, name: null };
  }
  const valueAfter = (prefix: string) => {
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    const value = line?.slice(prefix.length).trim() ?? "";
    return value || null;
  };
  return {
    exists: true,
    slug: valueAfter("Slug:"),
    name: valueAfter("Name:"),
  };
}

export function parseHermesSoulContent(output: string): HermesSoulContentResult {
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 1 && lines[0] === "Exists: no") {
    return { status: "missing" };
  }
  if (lines[0] !== "Exists: yes") {
    return { status: "invalid" };
  }

  const byteLengthLine = lines.find((line) => line.startsWith("ByteLength: "));
  const byteLengthValue = byteLengthLine?.slice("ByteLength: ".length) ?? "";
  if (!/^\d+$/.test(byteLengthValue)) {
    return { status: "invalid" };
  }
  const byteLength = Number(byteLengthValue);
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    return { status: "invalid" };
  }

  if (lines.includes("TooLarge: yes")) {
    if (
      lines.length !== 3
      || byteLength <= PERSONA_MARKDOWN_MAX_BYTES
      || lines.some((line) => line.startsWith("ContentBase64:"))
    ) {
      return { status: "invalid" };
    }
    return { status: "too_large", byteLength };
  }

  const contentLine = lines.find((line) => line.startsWith("ContentBase64: "));
  const contentBase64 = contentLine?.slice("ContentBase64: ".length) ?? "";
  const isStrictBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    contentBase64,
  );
  if (
    lines.length !== 3
    || byteLength > PERSONA_MARKDOWN_MAX_BYTES
    || !contentBase64
    || !isStrictBase64
  ) {
    return { status: "invalid" };
  }

  try {
    const binary = atob(contentBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== byteLength) {
      return { status: "invalid" };
    }
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { status: "ready", markdown, byteLength };
  } catch {
    return { status: "invalid" };
  }
}

export async function executeHermesPersonaCommand(
  bots: BotRepository,
  botId: string,
  command: string,
): Promise<{ status: string; exitCode: number; output: string }> {
  const result = await bots.execDebugCommand(
    botId,
    command,
    { timeoutMs: HERMES_PERSONA_COMMAND_TIMEOUT_MS },
  );
  if (!isExecCommandSucceeded(result)) {
    throw new Error(
      `Hermes persona command failed: ${truncateExecOutput(result.output, result.status)}`,
    );
  }
  return result;
}
