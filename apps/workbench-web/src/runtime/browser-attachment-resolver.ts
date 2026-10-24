import { uploadAttachmentChunks } from "@opencraft/workbench-runtime";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_LEGACY_MAX_BYTES } from "@opencraft/appserver-protocol";
import type { ComposerAttachment } from "@opencraft/composer-core";
import type { ImageProcessingService } from "@opencraft/image-processing";
import type {
  AttachmentUploadParams,
  AttachmentUploadResponse,
  AttachmentStageParams,
  AttachmentStageResponse,
} from "@opencraft/appserver-protocol";

/**
 * Inline images stay host-independent: the same payload works for a local,
 * SSH, durable, or browser-only AppServer connection.
 *
 * The limit is applied before base64's ~33% expansion so an accidental camera
 * original cannot turn one JSON-RPC request into an unbounded allocation.
 */
export const MAX_INLINE_BROWSER_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_STAGED_BROWSER_FILE_BYTES = ATTACHMENT_MAX_BYTES;
const INLINE_IMAGE_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

export type BrowserAttachmentErrorCode =
  | "EMPTY_ATTACHMENT"
  | "IMAGE_TOO_LARGE"
  | "UNSUPPORTED_IMAGE_TYPE"
  | "FILE_TOO_LARGE"
  | "HOST_FILE_STAGING_UNAVAILABLE";

export interface BrowserAttachmentStagingOptions {
  readonly maxBytes?: number;
  readonly chunkBytes?: number;
  readonly uploadChunk?: (params: AttachmentUploadParams) => Promise<AttachmentUploadResponse>;
  readonly uploadCancel?: (uploadId: string) => Promise<{ removed: boolean }>;
  readonly stage:
    | ((
        request: AttachmentStageParams,
        signal?: AbortSignal,
      ) => Promise<AttachmentStageResponse>)
    | null;
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

const hostFileUri = (path: string): string =>
  `file://${path.split("/").map((part) => encodeURIComponent(part)).join("/")}`;

/**
 * Resolves a browser-owned File into an inline image or Host-staged attachment.
 * A blob URL is intentionally never returned: only this browser can dereference
 * one, while a data URL survives WebSocket and SSH transport unchanged.
 */
export async function resolveBrowserAttachment(
  file: File,
  pending: ComposerAttachment,
  staging: BrowserAttachmentStagingOptions = { stage: null },
  images?: Pick<ImageProcessingService, "compress">,
  signal?: AbortSignal,
): Promise<ComposerAttachment> {
  const sourceType = (file.type === "" || file.type === "application/octet-stream") && /\.heic$/iu.test(file.name)
    ? "image/heic"
    : (file.type === "" || file.type === "application/octet-stream") && /\.heif$/iu.test(file.name)
      ? "image/heif"
      : file.type;
  const isImage = sourceType.startsWith("image/");
  const isHeic = sourceType === "image/heic" || sourceType === "image/heif";
  if (file.size === 0) {
    throw new BrowserAttachmentError(
      "EMPTY_ATTACHMENT",
      "The attachment is empty",
    );
  }
  if (isImage && file.size > MAX_INLINE_BROWSER_IMAGE_BYTES) {
    throw new BrowserAttachmentError(
      "IMAGE_TOO_LARGE",
      `Image is too large (maximum ${MAX_INLINE_BROWSER_IMAGE_BYTES / 1024 / 1024} MB)`,
    );
  }
  if (!isImage && file.size > MAX_STAGED_BROWSER_FILE_BYTES) {
    throw new BrowserAttachmentError(
      "FILE_TOO_LARGE",
      `File is too large (maximum ${MAX_STAGED_BROWSER_FILE_BYTES / 1024 / 1024} MB)`,
    );
  }

  signal?.throwIfAborted();
  const source = sourceType === file.type ? file : file.slice(0, file.size, sourceType);
  const processed = isImage && images ? await images.compress(source, { signal }) : null;
  const upload = processed?.blob ?? file;
  const mimeType = processed?.changed ? upload.type : sourceType;
  const imageExtension = INLINE_IMAGE_EXTENSIONS.get(mimeType);
  if (isImage && imageExtension === undefined) {
    throw new BrowserAttachmentError(
      "UNSUPPORTED_IMAGE_TYPE",
      isHeic
        ? "This browser could not convert the HEIC photo. Choose a JPEG or PNG copy."
        : `Unsupported image type: ${mimeType || "unknown"}. Use PNG, JPEG, WebP, or GIF.`,
    );
  }
  if (isImage && upload.size > MAX_INLINE_BROWSER_IMAGE_BYTES) {
    throw new BrowserAttachmentError(
      "IMAGE_TOO_LARGE",
      `Image is too large after processing (maximum ${MAX_INLINE_BROWSER_IMAGE_BYTES / 1024 / 1024} MB)`,
    );
  }
  const uploadName = processed?.changed && imageExtension !== undefined
    ? `${file.name.replace(/\.[^.]+$/u, "")}.${imageExtension}`
    : file.name;
  if (isImage) {
    const bytes = new Uint8Array(await upload.arrayBuffer());
    signal?.throwIfAborted();
    const dataBase64 = bytesToBase64(bytes);
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
        transport: "inline-image-url",
        originalBytes: file.size,
        compression: processed?.reason ?? "not-requested",
      },
    };
  }

  if (staging.stage === null) {
    throw new BrowserAttachmentError(
      "HOST_FILE_STAGING_UNAVAILABLE",
      "The selected Host is not ready to receive file attachments",
    );
  }

  const staged = await stageBrowserFile(file, pending.id, staging, signal);
  const uri = staged.ref.location.kind === "host-file"
    ? hostFileUri(staged.ref.location.path)
    : staged.ref.location.url;
  return {
    ...pending,
    name: staged.ref.name,
    size: staged.ref.size,
    mimeType: staged.ref.mimeType,
    uri,
    lifecycle: "ready",
    error: null,
    metadata: {
      ...pending.metadata,
      source: "browser-host-staged",
      transport: "opencraft-attachment-staging",
      attachmentRef: staged.ref,
    },
  };
}

async function stageBrowserFile(file: File, id: string, staging: BrowserAttachmentStagingOptions, signal?: AbortSignal): Promise<AttachmentStageResponse> {
  const chunked = staging.chunkBytes && staging.uploadChunk && staging.uploadCancel;
  const maxBytes = Math.min(MAX_STAGED_BROWSER_FILE_BYTES, staging.maxBytes ?? ATTACHMENT_LEGACY_MAX_BYTES,
    chunked ? MAX_STAGED_BROWSER_FILE_BYTES : ATTACHMENT_LEGACY_MAX_BYTES);
  if (file.size > maxBytes) throw new BrowserAttachmentError("FILE_TOO_LARGE", `File is too large (maximum ${maxBytes / 1024 / 1024} MB)`);
  const metadata = { clientAttachmentId: id, name: file.name, mimeType: file.type || "application/octet-stream", size: file.size };
  if (chunked) return uploadAttachmentChunks(metadata,
    async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
    { chunkBytes: staging.chunkBytes!, uploadChunk: staging.uploadChunk!, uploadCancel: staging.uploadCancel! }, signal);
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  return staging.stage!({ ...metadata, source: { kind: "client-bytes", dataBase64: bytesToBase64(bytes) } }, signal);
}
