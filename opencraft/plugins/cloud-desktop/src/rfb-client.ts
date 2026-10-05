/// <reference path="./novnc.d.ts" />
/** Public noVNC 1.5.0 API + reviewed firstframe/clipboardready events.
 * Installation verifies scripts/patch-novnc-desktop-events.mjs. No private fields. */
export interface RfbClient extends EventTarget {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  background: string;
  disconnect(): void;
  focus(options?: FocusOptions): void;
  blur(): void;
  clipboardPasteFrom(text: string): void;
  clearClipboard(): void;
  sendKey(keysym: number, code?: string, down?: boolean): void;
}

export interface RfbClientConstructor {
  new(element: HTMLElement, channel: WebSocket, options: { shared: boolean }): RfbClient;
}

export function resolveRfbClientExport(value: unknown): RfbClientConstructor {
  // Pinned npm entry is Babel CommonJS. ESM bundlers can expose either its
  // constructor or its exports object as `default`; validate this boundary.
  const constructor = typeof value === "function" ? value
    : value && typeof value === "object" ? (value as Record<string, unknown>).default : null;
  if (typeof constructor !== "function") throw new Error("Desktop decoder is unavailable");
  return constructor as RfbClientConstructor;
}

export async function loadRfbClient(): Promise<RfbClientConstructor> {
  const module = await import("@novnc/novnc/lib/rfb.js");
  return resolveRfbClientExport(module.default);
}
