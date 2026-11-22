/**
 * Whether the desktop runs builtin Codex through the daemon's bridge stack.
 *
 * macOS and Linux default to the bridge stack; `OPENCRAFT_CODEX_BRIDGE=0`
 * returns to the legacy local adapter as an escape hatch. Windows stays
 * opt-in (`=1`) until the stack is verified on real Windows machines.
 */
export function codexBridgeStackEnabled(platform: NodeJS.Platform, setting: string | undefined): boolean {
  const value = setting?.trim();
  if (value === "1") return true;
  if (value === "0") return false;
  return platform !== "win32";
}
