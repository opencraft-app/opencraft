import type { ComposerAttachment } from "@opencraft/composer-core";
import type { ImageProcessingService } from "@opencraft/image-processing";

/**
 * Inline images stay host-independent: the same payload works for a local,
 * SSH, durable, or browser-only AppServer connection.
 *
 * The limit is applied before base64's ~33% expansion so an accidental camera
 * original cannot turn one JSON-RPC request into an unbounded allocation.
 */
export const MAX_INLINE_BROWSER_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_STAGED_BROWSER_FILE_BYTES = 32 * 1024 * 1024;

export type BrowserAttachmentErrorCode =
  | "EMPTY_ATTACHMENT"
  | "IMAGE_TOO_LARGE"
  | "FILE_TOO_LARGE"
  | "HOST_FILE_STAGING_UNAVAILABLE";

export interface BrowserAttachmentStagingOptions {
  readonly directory: string | null;
  readonly writeFile: ((path: string, dataBase64: string) => Promise<unknown>) | null;
}

export class BrowserAttachmentError extends Error {
  readonly code: BrowserAttachmentErrorCode;

  constructor(code: BrowserAttachmentErrorCode, message: string) {
    super(message);
    this.name = "BrowserAttachmentError";
    this.code = code;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

const safePathSegment = (value: string, fallback: string): string => {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 180);
  return sanitized || fallback;
};

const joinAbsolutePath = (directory: string, fileName: string): string =>
  `${directory.replace(/\/+$/u, "")}/${fileName}`;

/**
 * Resolves a browser-owned File into Codex AppServer's native `image` input.
 * A blob URL is intentionally never returned: only this browser can dereference
 * one, while a data URL survives WebSocket and SSH transport unchanged.
 */
export async function resolveBrowserAttachment(
  file: File,
  pending: ComposerAttachment,
  staging: BrowserAttachmentStagingOptions = { directory: null, writeFile: null },
  images?: Pick<ImageProcessingService, "compress">,
  signal?: AbortSignal,
): Promise<ComposerAttachment> {
  if (file.size === 0) {
    throw new BrowserAttachmentError(
      "EMPTY_ATTACHMENT",
      "The attachment is empty",
    );
  }
  if (file.type.startsWith("image/") && file.size > MAX_INLINE_BROWSER_IMAGE_BYTES) {
    throw new BrowserAttachmentError(
      "IMAGE_TOO_LARGE",
      `Image is too large (maximum ${MAX_INLINE_BROWSER_IMAGE_BYTES / 1024 / 1024} MB)`,
    );
  }
  if (!file.type.startsWith("image/") && file.size > MAX_STAGED_BROWSER_FILE_BYTES) {
    throw new BrowserAttachmentError(
      "FILE_TOO_LARGE",
      `File is too large (maximum ${MAX_STAGED_BROWSER_FILE_BYTES / 1024 / 1024} MB)`,
    );
  }

  signal?.throwIfAborted();
  const processed = file.type.startsWith("image/") && images ? await images.compress(file, { signal }) : null;
  const upload = processed?.blob ?? file;
  const mimeType = processed?.changed ? upload.type : file.type;
  const uploadName = processed?.changed
    ? `${file.name.replace(/\.[^.]+$/u, "")}.${mimeType === "image/png" ? "png" : "jpg"}`
    : file.name;
  const bytes = new Uint8Array(await upload.arrayBuffer());
  signal?.throwIfAborted();
  const dataBase64 = bytesToBase64(bytes);
  if (file.type.startsWith("image/")) {
    return {
      ...pending,
      name: uploadName,
      size: upload.size,
      mimeType,
      uri: `data:${mimeType};base64,${dataBase64}`,
      lifecycle: "ready",
      error: null,
      metadata: {
        ...pending.metadata,
        source: "browser-inline",
        transport: "codex-image-url",
        originalBytes: file.size,
        compression: processed?.reason ?? "not-requested",
      },
    };
  }

  if (!staging.directory?.startsWith("/") || staging.writeFile === null) {
    throw new BrowserAttachmentError(
      "HOST_FILE_STAGING_UNAVAILABLE",
      "The selected Host is not ready to receive file attachments",
    );
  }

  const attachmentId = safePathSegment(pending.id, "attachment");
  const fileName = safePathSegment(file.name, "file");
  const path = joinAbsolutePath(staging.directory, `${attachmentId}-${fileName}`);
  await staging.writeFile(path, dataBase64);
  return {
    ...pending,
    mimeType: file.type || "application/octet-stream",
    uri: `file://${path}`,
    lifecycle: "ready",
    error: null,
    metadata: {
      ...pending.metadata,
      source: "browser-host-staged",
      transport: "appserver-fs-write-file",
      path,
    },
  };
}
