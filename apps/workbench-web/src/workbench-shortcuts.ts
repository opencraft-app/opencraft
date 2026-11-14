/** Web/Electron command bindings. */
export const workbenchShortcuts = {
  newChat: [{ key: "o", shift: true }],
  search: [{ key: "k" }],
  settings: [{ key: "," }],
  sidebar: [{ key: "\\" }, { key: "b" }],
  panel: [{ key: "j" }, { key: "i", shift: true }],
  composer: [{ key: "c", shift: true }],
  help: [{ key: "/" }],
  agentNext: [{ key: "p", alt: true }],
  agentPrevious: [{ key: "p", alt: true, shift: true }],
} satisfies Record<string, readonly ShortcutBinding[]>;
export type WorkbenchShortcutCommand = keyof typeof workbenchShortcuts;
interface ShortcutBinding {
  readonly key: string;
  readonly shift?: boolean;
  /** Alt-only command; it intentionally does not combine with the platform modifier. */
  readonly alt?: boolean;
}
type KeyInput = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing"> & { readonly code?: string };
export function isMacKeyboard(platform: string): boolean { return /Mac|iPhone|iPad/.test(platform); }
function shortcutKey(event: KeyInput, preferPhysicalKey: boolean): string {
  // Option changes event.key on macOS (Option+P becomes "π"), and a keyboard
  // layout may map the chord to another character. Alt bindings therefore use
  // the physical key first; code-less synthetic events still fall back to key.
  if (preferPhysicalKey) {
    const physical = /^(?:Key([A-Z])|Digit([0-9]))$/u.exec(event.code ?? "");
    const value = physical?.[1] ?? physical?.[2];
    if (value) return value.toLowerCase();
  }
  if (event.altKey && !/^[a-z0-9]$/iu.test(event.key)) {
    const letter = event.code === undefined ? undefined : /^Key([A-Z])$/u.exec(event.code)?.[1];
    if (letter) return letter.toLowerCase();
  }
  return event.key.toLowerCase();
}
function matchesBinding(event: KeyInput, binding: ShortcutBinding, platform: string): boolean {
  const modifier = binding.alt
    ? event.altKey && !event.metaKey && !event.ctrlKey
    : (isMacKeyboard(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey;
  return modifier && shortcutKey(event, binding.alt === true) === binding.key && event.shiftKey === (binding.shift ?? false);
}
export function matchesWorkbenchShortcut(event: KeyInput, command: WorkbenchShortcutCommand, platform: string): boolean {
  return !event.isComposing
    && workbenchShortcuts[command].some((binding) => matchesBinding(event, binding, platform));
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
  const binding: ShortcutBinding = workbenchShortcuts[command][index]!;
  const shift = binding.shift ? "⇧" : "";
  return isMacKeyboard(platform)
    ? binding.alt ? `⌥${shift}${binding.key.toUpperCase()}` : `⌘${shift}${binding.key.toUpperCase()}`
    : `${binding.alt ? "Alt" : "Ctrl"}+${binding.shift ? "Shift+" : ""}${binding.key.toUpperCase()}`;
}
export function shortcutAria(command: WorkbenchShortcutCommand, platform = navigator.platform, index = 0): string {
  const binding: ShortcutBinding = workbenchShortcuts[command][index]!;
  return `${binding.alt ? "Alt" : isMacKeyboard(platform) ? "Meta" : "Control"}+${binding.shift ? "Shift+" : ""}${binding.key.toUpperCase()}`;
}
