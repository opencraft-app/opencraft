import type { RfbClient } from "./rfb-client";

/** Clipboard data belongs to one focused input grant and one user gesture. */
export function bindDesktopClipboard(element: HTMLElement, client: RfbClient,
  allowed: () => boolean, paste: (read: () => Promise<string>) => void) {
  const view = element.ownerDocument.defaultView!;
  let pasteKey = false, pasteMeta = false;
  let copy: { accept(text: string): void; cancel(): void } | null = null;
  const reset = () => { pasteKey = false; pasteMeta = false; copy?.cancel(); };
  const releaseMeta = () => {
    client.sendKey(0xffeb, "MetaLeft", false);
    client.sendKey(0xffec, "MetaRight", false);
  };
  const beginCopy = () => {
    if (copy) return;
    const clipboard = view.navigator.clipboard;
    if (!clipboard || typeof clipboard.write !== "function" && typeof clipboard.writeText !== "function") return;
    let accept!: (value: Blob) => void, reject!: (reason: Error) => void;
    const text = new Promise<Blob>((yes, no) => { accept = yes; reject = no; });
    // Install a rejection handler even when the browser only offers writeText.
    void text.catch(() => {});
    const finish = () => { view.clearTimeout(timer); if (copy === transaction) copy = null; };
    const transaction = {
      accept(value: string) {
        if (copy !== transaction || !allowed() || value.length > 16_384) { transaction.cancel(); return; }
        finish();
        accept(new view.Blob([value], { type: "text/plain" }));
        if (!modern) void clipboard.writeText(value).catch(() => {});
      },
      cancel() { finish(); reject(new Error("Desktop copy retired")); },
    };
    const timer = view.setTimeout(() => transaction.cancel(), 5_000);
    copy = transaction;
    const modern = typeof clipboard.write === "function" && typeof view.ClipboardItem === "function";
    // Start the browser write during Ctrl/Cmd+C. The peer supplies the Blob
    // later; no remote update without this gesture can overwrite local data.
    if (modern) {
      try { void clipboard.write([new view.ClipboardItem({ "text/plain": text })]).catch(() => transaction.cancel()); }
      catch { transaction.cancel(); }
    }
  };
  const down = (event: KeyboardEvent) => {
    if (!allowed() || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === "v") {
      // Preserve the browser's native paste event, whose clipboardData needs
      // no asynchronous read permission. Only suppress noVNC's raw V writer.
      pasteKey = true; pasteMeta = event.metaKey; event.stopImmediatePropagation();
    } else if (key === "c" && !event.repeat) {
      beginCopy();
      if (event.metaKey && !event.ctrlKey) {
        event.preventDefault(); event.stopImmediatePropagation();
        releaseMeta();
        client.sendKey(0xffe3, "ControlLeft", true);
        client.sendKey(0x63, "KeyC");
        client.sendKey(0xffe3, "ControlLeft", false);
      }
    }
  };
  const up = (event: KeyboardEvent) => {
    if (pasteKey && event.key.toLowerCase() === "v") {
      pasteKey = false; event.stopImmediatePropagation();
    }
  };
  const pasted = (event: ClipboardEvent) => {
    if (!allowed() || !event.clipboardData) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (pasteMeta) { releaseMeta(); pasteMeta = false; }
    const text = event.clipboardData.getData("text/plain");
    paste(async () => text);
  };
  const copied = (event: Event) => {
    const text: unknown = (event as CustomEvent<{ text?: unknown }>).detail?.text;
    if (typeof text === "string") copy?.accept(text);
  };
  element.addEventListener("keydown", down, true);
  element.addEventListener("keyup", up, true);
  element.addEventListener("paste", pasted, true);
  client.addEventListener("clipboard", copied);
  return { reset, dispose() {
    reset();
    element.removeEventListener("keydown", down, true);
    element.removeEventListener("keyup", up, true);
    element.removeEventListener("paste", pasted, true);
    client.removeEventListener("clipboard", copied);
  } };
}
