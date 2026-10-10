import type { NativeAttachmentSource } from "./native-attachment-resolver";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
};

const EXTENSION_BY_IMAGE_MIME: Readonly<Record<string, string>> = {
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function extension(value: string): string | null {
  const pathname = value.split(/[?#]/u, 1)[0] ?? "";
  const match = /\.([a-z0-9]+)$/iu.exec(pathname);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Picker metadata is optional on iOS; keep photos on the image path even then. */
export function prepareNativeAttachmentSource(
  source: { readonly uri: string; readonly name?: string | null; readonly mimeType?: string | null; readonly size?: number },
  kind: "photo" | "file",
  fallbackId: string,
): NativeAttachmentSource {
  const declaredMime = source.mimeType?.trim().toLowerCase() ?? "";
  const declaredName = source.name?.trim() ?? "";
  const uriExtension = extension(source.uri);
  const fallbackExtension = EXTENSION_BY_IMAGE_MIME[declaredMime]
    ?? (uriExtension && MIME_BY_EXTENSION[uriExtension]?.startsWith("image/") ? uriExtension : null)
    ?? "jpg";
  const name = declaredName || (kind === "photo" ? `photo-${fallbackId}.${fallbackExtension}` : `file-${fallbackId}`);
  const mimeType = declaredMime && declaredMime !== "application/octet-stream"
    ? declaredMime
    : MIME_BY_EXTENSION[extension(declaredName) ?? ""]
      ?? MIME_BY_EXTENSION[uriExtension ?? ""]
      ?? (kind === "photo" ? "image/unknown" : "application/octet-stream");
  return { uri: source.uri, name, mimeType, size: source.size };
}
