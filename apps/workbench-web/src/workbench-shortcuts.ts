/** Web/Electron command bindings. */
export const workbenchShortcuts = {
  newChat: [{ key: "o", shift: true }],
  search: [{ key: "k" }],
  settings: [{ key: "," }],
  sidebar: [{ key: "\\" }, { key: "b" }],
  panel: [{ key: "j" }, { key: "i", shift: true }],
  composer: [{ key: "c", shift: true }],
  help: [{ key: "/" }],
} satisfies Record<string, readonly { key: string; shift?: boolean }[]>;
export type WorkbenchShortcutCommand = keyof typeof workbenchShortcuts;
type KeyInput = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing">;
export function isMacKeyboard(platform: string): boolean { return /Mac|iPhone|iPad/.test(platform); }
export function matchesWorkbenchShortcut(event: KeyInput, command: WorkbenchShortcutCommand, platform: string): boolean {
  return !event.isComposing && !event.altKey
    && (isMacKeyboard(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
    && workbenchShortcuts[command].some((binding: { key: string; shift?: boolean }) =>
      event.key.toLowerCase() === binding.key && event.shiftKey === (binding.shift ?? false));
}
/** Focused editors may use explicit app commands; overlays and remote input own theirs. */
export function canHandleWorkbenchShortcut(event: KeyboardEvent, ownedDialog?: string): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return false;
  return !(event.composedPath().length ? event.composedPath() : [event.target]).some(target => {
    if (!(target instanceof Element)) return false;
    const owner = target.closest(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .terminal-panel, .cloud-desktop-panel, [data-disable-workbench-shortcuts="true"]',
    );
    return owner !== null && !(ownedDialog && owner.matches(`[role="dialog"]${ownedDialog}`));
  });
}
export function shortcutLabel(command: WorkbenchShortcutCommand, platform = navigator.platform, index = 0): string {
  const binding: { key: string; shift?: boolean } = workbenchShortcuts[command][index]!;
  return isMacKeyboard(platform)
    ? `⌘${binding.shift ? "⇧" : ""}${binding.key.toUpperCase()}`
    : `Ctrl+${binding.shift ? "Shift+" : ""}${binding.key.toUpperCase()}`;
}
export function shortcutAria(command: WorkbenchShortcutCommand, platform = navigator.platform, index = 0): string {
  const binding: { key: string; shift?: boolean } = workbenchShortcuts[command][index]!;
  return `${isMacKeyboard(platform) ? "Meta" : "Control"}+${binding.shift ? "Shift+" : ""}${binding.key.toUpperCase()}`;
}
