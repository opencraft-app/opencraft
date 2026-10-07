import type { ChatRenderContext, ChatResourceDecision } from "./contracts";

/** A rendered image must not inherit the previous document's Host-loaded bytes. */
export function chatMediaPresentationKey(
  source: string,
  decision: ChatResourceDecision,
  context: Pick<ChatRenderContext, "hostId" | "conversationId" | "cwd" | "documentId">,
): string {
  return JSON.stringify([
    context.hostId ?? null,
    context.conversationId ?? null,
    context.cwd ?? null,
    context.documentId,
    decision.kind ?? "blocked",
    decision.target ?? source,
  ]);
}

const mimeByExtension: Readonly<Record<string, string>> = Object.freeze({
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
});

/** File extension is only a display hint; platform decoders still validate bytes. */
export function chatMediaMimeType(path: string): string {
  const extension = /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase() ?? "";
  return mimeByExtension[extension] ?? "application/octet-stream";
}
