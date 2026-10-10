import type { ChatResourceOpenIntent } from "@opencraft/chat-render-react";
export { SAFE_URL_SETTLE_MS } from "@opencraft/chat-render-react";

export function faviconSources(target: string): readonly string[] {
  try {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    return [
      `${url.origin}/favicon.ico`,
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.origin)}&sz=32`,
    ];
  } catch {
    return [];
  }
}

export function externalLinkPointerIntent(input: {
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly detail: number;
  readonly metaKey: boolean;
}): ChatResourceOpenIntent | null {
  if (input.button !== 0 && input.button !== 1) return null;
  return {
    source: input.detail === 0 ? "keyboard" : "pointer",
    target: "default",
    disposition: input.button === 1 || input.metaKey || input.ctrlKey
      ? "new-tab"
      : "current-tab",
  };
}

export function externalLinkMenuIntent(
  target: "in-app-browser" | "external-browser",
): ChatResourceOpenIntent {
  return { source: "context-menu", target, disposition: "current-tab" };
}
