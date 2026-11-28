/**
 * Builtin Codex runs exclusively through the daemon's bridge stack across all
 * desktop platforms (macOS, Linux, Windows).
 */
export function codexBridgeStackEnabled(_platform: NodeJS.Platform, _setting?: string): boolean {
  return true;
}
