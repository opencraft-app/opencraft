import type { BotRepository } from "@/repositories/types";
import {
  isExecCommandSucceeded,
  truncateExecOutput,
} from "@/pages/marketing/agent-reset-config";

export const HERMES_PERSONA_COMMAND_TIMEOUT_MS = 120_000;

const HERMES_ROOT_COMMAND = 'HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"';

export function buildHermesSoulWriteCommand(
  markdownBase64: string,
  timestamp: string,
): string {
  return [
    "set -e",
    HERMES_ROOT_COMMAND,
    'BACKUP_DIR="$HERMES_ROOT/.soul-backups"',
    'mkdir -p "$HERMES_ROOT" "$BACKUP_DIR"',
    'TARGET="$HERMES_ROOT/SOUL.md"',
    `BACKUP="$BACKUP_DIR/${timestamp}.md"`,
    'if [ -s "$TARGET" ]; then cp "$TARGET" "$BACKUP"; fi',
    "cat <<'__CTL_SOUL_EOF__' | base64 -d > \"$TARGET\"",
    markdownBase64,
    "__CTL_SOUL_EOF__",
  ].join("\n");
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
    '  grep -m1 "^Slug:" "$TARGET" 2>/dev/null || true',
    "fi",
  ].join("\n");
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
