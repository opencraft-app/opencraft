import type { Terminal } from "@xterm/xterm";
import { touchPanAxis } from "@opencraft/design-system-web/touch-contact";

export function hasTerminalNativeSelection(host: HTMLElement): boolean {
  const selection = host.ownerDocument.getSelection();
  const text = host.querySelector("[data-terminal-native-text]");
  return (
    !!selection &&
    !selection.isCollapsed &&
    selection.rangeCount > 0 &&
    !!text &&
    (text.contains(selection.anchorNode) || text.contains(selection.focusNode))
  );
}

// Copy the pinned DOM renderer's resolved glyph geometry, never measure a
// second character grid. These are plain text nodes, without xterm listeners.
const paintProperties = [
  "display",
  "width",
  "height",
  "vertical-align",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-kerning",
  "font-feature-settings",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variation-settings",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "white-space",
  "direction",
  "unicode-bidi",
  "text-transform",
  "text-rendering",
  "color",
  "background-color",
  "text-decoration",
  "text-shadow",
  "box-shadow",
  "outline",
  "outline-offset",
  "box-sizing",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "margin-left",
  "margin-right",
  "padding-left",
  "padding-right",
  "transform",
  "transform-origin",
  "animation-name",
  "animation-duration",
  "animation-timing-function",
  "animation-iteration-count",
];
function copyTextRow(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  const sources = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const targets = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  for (let index = 0; index < sources.length; index++) {
    const target = targets[index]!,
      styles = getComputedStyle(sources[index]!);
    target.removeAttribute("class");
    target.removeAttribute("id");
    target.removeAttribute("style");
    for (const property of paintProperties) target.style.setProperty(property, styles.getPropertyValue(property));
  }
  return clone;
}

/** A stable native text presentation of the same physical terminal. xterm
 * continues parsing output, responding to applications and owning the grid.
 * Only these text nodes are held while native handles/a contact owns them.
 */
export function attachTerminalNativeSelection(
  terminal: Terminal,
  host: HTMLElement,
  active: () => boolean,
  touchPresentation: () => boolean,
  changed: () => void,
) {
  const document = host.ownerDocument;
  const text = document.createElement("div");
  text.dataset.terminalNativeText = "";
  text.className = "terminal-native-text";
  text.hidden = true;
  host.append(text);
  let contact: { id: number; x: number; y: number } | null = null;
  let pointerType = touchPresentation() ? "touch" : "mouse",
    enabled = false,
    selected = false;
  let paintKey = "";
  const rowKeys: string[] = [];
  const selectedHere = () => hasTerminalNativeSelection(host);
  const sourceRows = () => terminal.element?.querySelector<HTMLElement>(".xterm-rows");
  const available = () =>
    active() &&
    touchPresentation() &&
    terminal.modes.mouseTrackingMode === "none" &&
    !!sourceRows() &&
    (pointerType !== "mouse" || selectedHere());
  const updateText = () => {
    if (!enabled || contact || selectedHere()) return;
    const rows = sourceRows(),
      screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!rows || !screen || !host.clientWidth || !host.clientHeight) return;
    const bounds = screen.getBoundingClientRect(),
      parent = host.getBoundingClientRect();
    const scaleX = parent.width / host.clientWidth,
      scaleY = parent.height / host.clientHeight;
    if (!(scaleX > 0 && scaleY > 0)) return;
    text.style.left = `${(bounds.left - parent.left) / scaleX}px`;
    text.style.top = `${(bounds.top - parent.top) / scaleY}px`;
    text.style.width = `${screen.offsetWidth}px`;
    text.style.height = `${screen.offsetHeight}px`;
    const styles = getComputedStyle(rows);
    text.style.backgroundColor = getComputedStyle(terminal.element!.querySelector(".xterm-viewport")!).backgroundColor;
    const nextPaint = [
      rows.className,
      screen.offsetWidth,
      screen.offsetHeight,
      ...paintProperties.map((property) => styles.getPropertyValue(property)),
    ].join("|");
    const allChanged = nextPaint !== paintKey;
    paintKey = nextPaint;
    const replacements: { row: number; clone: HTMLElement; key: string }[] = [];
    for (let row = 0; row < rows.children.length; row++) {
      const source = rows.children[row] as HTMLElement,
        key = source.outerHTML;
      if (!allChanged && rowKeys[row] === key && text.children[row]) continue;
      replacements.push({ row, clone: copyTextRow(source), key });
    }
    // Resolve source styles before changing the live text tree, avoiding one
    // forced layout per row during a scroll or the first foreground handoff.
    for (const { row, clone, key } of replacements) {
      if (text.children[row]) text.replaceChild(clone, text.children[row]!);
      else text.append(clone);
      rowKeys[row] = key;
    }
    while (text.children.length > rows.children.length) text.lastElementChild!.remove();
    rowKeys.length = rows.children.length;
  };
  const sync = () => {
    const nextEnabled = available();
    if (!nextEnabled) {
      contact = null;
      if (selectedHere()) document.getSelection()?.removeAllRanges();
    }
    const nextSelected = nextEnabled && selectedHere();
    const becomingSelected = nextSelected && !selected;
    const notify = nextEnabled !== enabled || nextSelected !== selected;
    const becomingEnabled = nextEnabled && !enabled;
    enabled = nextEnabled;
    selected = nextSelected;
    text.hidden = !enabled;
    host.dataset.nativeSelection = String(enabled);
    if (becomingEnabled) terminal.clearSelection();
    if (becomingSelected && document.activeElement === terminal.textarea) terminal.blur();
    updateText();
    if (notify) changed();
  };
  const pointer = (event: PointerEvent) => {
    if (pointerType !== event.pointerType) {
      pointerType = event.pointerType;
      sync();
    }
  };
  const pointerOver = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") pointer(event);
  };
  const pointerMove = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && (event.movementX || event.movementY)) pointer(event);
  };
  const touchStart = (event: TouchEvent) => {
    pointerType = "touch";
    const touch = event.touches.length === 1 ? event.touches[0]! : null;
    contact = touch ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
    sync();
  };
  const touchMove = (event: TouchEvent) => {
    if (!contact || selectedHere()) return;
    const touch = Array.from(event.touches).find((touch) => touch.identifier === contact!.id);
    if (
      !touch ||
      event.touches.length !== 1 ||
      touchPanAxis(touch.clientX - contact.x, touch.clientY - contact.y) !== "pending"
    ) {
      contact = null;
      sync();
    }
  };
  const release = () => {
    contact = null;
    sync();
  };
  const click = (event: MouseEvent) => {
    if (enabled && !selectedHere() && event.button === 0 && event.detail === 1) terminal.focus();
  };
  const visibilityChanged = () => {
    if (document.visibilityState !== "visible") release();
  };
  host.addEventListener("pointerover", pointerOver, true);
  host.addEventListener("pointermove", pointerMove, true);
  host.addEventListener("pointerdown", pointer, true);
  host.addEventListener("touchstart", touchStart, { capture: true, passive: true });
  host.addEventListener("touchmove", touchMove, { capture: true, passive: true });
  text.addEventListener("click", click);
  document.addEventListener("touchend", release, true);
  document.addEventListener("touchcancel", release, true);
  document.addEventListener("selectionchange", sync);
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("blur", release);
  window.addEventListener("pagehide", release);
  sync();
  return {
    sync,
    clear() {
      contact = null;
      if (selectedHere()) document.getSelection()?.removeAllRanges();
      sync();
    },
    dispose() {
      host.removeEventListener("pointerover", pointerOver, true);
      host.removeEventListener("pointermove", pointerMove, true);
      host.removeEventListener("pointerdown", pointer, true);
      host.removeEventListener("touchstart", touchStart, true);
      host.removeEventListener("touchmove", touchMove, true);
      text.removeEventListener("click", click);
      document.removeEventListener("touchend", release, true);
      document.removeEventListener("touchcancel", release, true);
      document.removeEventListener("selectionchange", sync);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("blur", release);
      window.removeEventListener("pagehide", release);
      if (selectedHere()) document.getSelection()?.removeAllRanges();
      text.remove();
      delete host.dataset.nativeSelection;
    },
  };
}
