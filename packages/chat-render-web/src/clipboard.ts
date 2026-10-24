export interface ClipboardWritePort {
  readonly writeModern?: (text: string) => Promise<void>;
  readonly writeLegacy?: (text: string) => boolean;
}

export type ClipboardPayload = string | Readonly<Record<string, string | Blob>>;

/**
 * One Web clipboard contract for HTTPS, Electron and insecure browser previews.
 * Modern denial intentionally falls through to the legacy selection path.
 */
export async function writeTextWithClipboardFallback(
  text: string,
  port: ClipboardWritePort,
): Promise<void> {
  if (port.writeModern !== undefined) {
    try {
      await port.writeModern(text);
      return;
    } catch {
      // Electron policy and non-secure browser contexts may reject this path.
    }
  }
  if (port.writeLegacy?.(text) === true) return;
  throw new Error("Clipboard write is unavailable");
}

function legacyDocumentWrite(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  input.style.pointerEvents = "none";
  document.body.append(input);
  input.select();
  try {
    return document.execCommand("copy");
  } finally {
    input.remove();
  }
}

export function writeTextToClipboard(text: string): Promise<void> {
  const modern = typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined
    ? (value: string) => navigator.clipboard.writeText(value)
    : undefined;
  return writeTextWithClipboardFallback(text, {
    writeModern: modern,
    writeLegacy: legacyDocumentWrite,
  });
}

export async function writeToClipboard(
  data: ClipboardPayload,
  target?: Element | null,
): Promise<void> {
  const view = target?.ownerDocument.defaultView
    ?? (typeof window === "undefined" ? null : window);
  const clipboard = view?.navigator.clipboard;
  const plainText = typeof data === "string" ? data : data["text/plain"];
  const fallbackText = typeof plainText === "string" ? plainText : "";

  if (clipboard !== undefined) {
    try {
      const ClipboardItemConstructor = (view as (Window & typeof globalThis) | null)?.ClipboardItem;
      if (
        typeof data !== "string"
        && typeof clipboard.write === "function"
        && ClipboardItemConstructor !== undefined
      ) {
        const entries = Object.entries(data).map(([mime, value]) => [
          mime,
          typeof value === "string" ? new Blob([value], { type: mime }) : value,
        ] as const);
        await clipboard.write([new ClipboardItemConstructor(Object.fromEntries(entries))]);
        return;
      }
      if (typeof clipboard.writeText === "function") {
        await clipboard.writeText(fallbackText);
        return;
      }
    } catch {
      // Browser permission policy may reject ClipboardItem and writeText.
    }
  }
  if (legacyDocumentWrite(fallbackText)) return;
  throw new Error("Clipboard write is unavailable");
}
