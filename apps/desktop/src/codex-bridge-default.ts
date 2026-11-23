/**
 * Whether the desktop runs builtin Codex through the daemon's bridge stack.
 *
 * Every platform defaults to the bridge stack (Windows is verified by
 * .github/workflows/windows-codex-bridge.yml); `OPENCRAFT_CODEX_BRIDGE=0`
 * returns to the legacy local adapter as an escape hatch.
 */
export function codexBridgeStackEnabled(_platform: NodeJS.Platform, setting: string | undefined): boolean {
  return setting?.trim() !== "0";
}
