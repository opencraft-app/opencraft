import type { ChatResourceDecision } from "@opencraft/chat-render-react";

export type NativeChatResourceAction =
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "file"; readonly path: string; readonly title: string }
  | { readonly kind: "unavailable" };

/** Host navigation never passes workspace paths to the phone's file:// handler. */
export function nativeChatResourceAction(target: string, decision: ChatResourceDecision): NativeChatResourceAction {
  if (!decision.allowed || decision.target !== target) return { kind: "unavailable" };
  if (decision.kind === "external" && target.startsWith("//")) return { kind: "external", url: `https:${target}` };
  if ((decision.kind === "external" || decision.kind === "mail")
    && /^(?:https?:|mailto:|tel:|sms:)/iu.test(target)) return { kind: "external", url: target };
  if (decision.kind !== "file" && decision.kind !== "workspace-file") return { kind: "unavailable" };
  try {
    const url = new URL(target);
    if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost")) return { kind: "unavailable" };
    const path = decodeURIComponent(url.pathname);
    if (!path.startsWith("/") || path.includes("\0")) return { kind: "unavailable" };
    return { kind: "file", path, title: `${path}${url.hash}` };
  } catch {
    return { kind: "unavailable" };
  }
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MAX_PREVIEW_BYTES = 512 * 1024;

/** Text preview is intentionally bounded; binary and oversized files need a different Host surface. */
export function decodeNativeChatResourceText(base64: string): string | null {
  if (base64.length > Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 || base64.length % 4 !== 0) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const byteLength = base64.length / 4 * 3 - padding;
  if (byteLength > MAX_PREVIEW_BYTES) return null;
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (let index = 0; index < base64.length; index += 4) {
    const a = base64Alphabet.indexOf(base64[index]!);
    const b = base64Alphabet.indexOf(base64[index + 1]!);
    const c = base64[index + 2] === "=" ? 0 : base64Alphabet.indexOf(base64[index + 2]!);
    const d = base64[index + 3] === "=" ? 0 : base64Alphabet.indexOf(base64[index + 3]!);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    if (offset < byteLength) bytes[offset++] = (a << 2) | (b >> 4);
    if (offset < byteLength) bytes[offset++] = ((b & 15) << 4) | (c >> 2);
    if (offset < byteLength) bytes[offset++] = ((c & 3) << 6) | d;
  }
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}
