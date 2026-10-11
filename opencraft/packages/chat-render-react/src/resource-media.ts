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
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg; codecs=opus",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  pdf: "application/pdf",
});

export type ChatMediaKind = "image" | "audio" | "video" | "pdf" | "file";

export function chatMediaKind(path: string): ChatMediaKind {
  const mime = chatMediaMimeType(path);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return mime === "application/pdf" ? "pdf" : "file";
}

/** File extension is only a display hint; platform decoders still validate bytes. */
export function chatMediaMimeType(path: string): string {
  const extension = /\.([a-z0-9]+)$/iu.exec(path.split(/[?#]/u, 1)[0] ?? path)?.[1]?.toLowerCase() ?? "";
  return mimeByExtension[extension] ?? "application/octet-stream";
}
