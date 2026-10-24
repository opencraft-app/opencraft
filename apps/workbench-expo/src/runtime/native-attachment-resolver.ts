import { ATTACHMENT_MAX_BYTES, ATTACHMENT_LEGACY_MAX_BYTES } from "@opencraft/appserver-protocol";
import { uploadAttachmentChunks, type AttachmentChunkPort } from "@opencraft/workbench-runtime";
import { File, FileMode } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import type { AttachmentStageParams, AttachmentStageResponse } from "@opencraft/appserver-protocol";
import type { ComposerAttachment } from "@opencraft/composer-core";

export interface NativeAttachmentSource {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number;
}

export interface NativeAttachmentStaging extends Partial<AttachmentChunkPort> {
  readonly maxBytes: number;
  stage(request: AttachmentStageParams): Promise<AttachmentStageResponse>;
}

const IMAGE_LIMIT = 20 * 1024 * 1024;
const FILE_LIMIT = ATTACHMENT_MAX_BYTES;
const SUPPORTED_IMAGES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function hostFileUri(path: string): string {
  return `file://${path.split("/").map(part => encodeURIComponent(part)).join("/")}`;
}

/** The native picker is a producer; the shared Composer Draft owns the result. */
export async function resolveNativeAttachment(
  source: NativeAttachmentSource,
  pending: ComposerAttachment,
  staging: NativeAttachmentStaging | null,
  signal?: AbortSignal,
): Promise<ComposerAttachment> {
  signal?.throwIfAborted();
  let uri = source.uri;
  let name = source.name;
  let mimeType = source.mimeType || "application/octet-stream";
  let convertedUri: string | null = null;
  const originalSize = new File(uri).size;
  if (originalSize <= 0) throw new Error("The selected file is empty");
  if (mimeType.startsWith("image/") && originalSize > IMAGE_LIMIT) throw new Error("The image is too large");
  if (!mimeType.startsWith("image/") && originalSize > FILE_LIMIT) throw new Error("The file is too large");
  if (mimeType.startsWith("image/") && !SUPPORTED_IMAGES.has(mimeType)) {
    const converted = await manipulateAsync(uri, [], { compress: 0.86, format: SaveFormat.JPEG });
    uri = converted.uri;
    if (uri !== source.uri) convertedUri = uri;
    name = `${name.replace(/\.[^.]+$/u, "")}.jpg`;
    mimeType = "image/jpeg";
  }
  if (!mimeType.startsWith("image/") && staging?.chunkBytes && staging.uploadChunk && staging.uploadCancel) {
    if (originalSize > staging.maxBytes) throw new Error("The file is too large");
    const handle = new File(uri).open(FileMode.ReadOnly);
    let staged: AttachmentStageResponse;
    try {
      staged = await uploadAttachmentChunks({ clientAttachmentId: pending.id, name, mimeType, size: originalSize },
        async (offset, length) => { handle.offset = offset; return handle.readBytes(length); },
        { chunkBytes: staging.chunkBytes, uploadChunk: staging.uploadChunk, uploadCancel: staging.uploadCancel }, signal);
    } finally { handle.close(); }
    return {
      ...pending, name: staged.ref.name, mimeType: staged.ref.mimeType, size: staged.ref.size,
      uri: staged.ref.location.kind === "host-file" ? hostFileUri(staged.ref.location.path) : staged.ref.location.url,
      lifecycle: "ready", error: null,
      metadata: { ...pending.metadata, source: "native-host-staged", transport: "opencraft-attachment-staging", attachmentRef: staged.ref },
    };
  }
  let size: number;
  let dataBase64: string;
  try {
    signal?.throwIfAborted();
    const file = new File(uri);
    size = file.size;
    if (size <= 0) throw new Error("The selected file is empty");
    if (mimeType.startsWith("image/") && size > IMAGE_LIMIT) throw new Error("The image is too large");
    if (!mimeType.startsWith("image/") && (staging === null || size > Math.min(staging.maxBytes, ATTACHMENT_LEGACY_MAX_BYTES))) {
      throw new Error(staging === null ? "This agent cannot receive files" : "The file is too large");
    }
    dataBase64 = await file.base64();
    signal?.throwIfAborted();
  } finally {
    // ImageManipulator owns this JPEG cache file; the Draft previews the
    // original picker URI and sends the encoded bytes, so it can be removed.
    if (convertedUri !== null) {
      try { new File(convertedUri).delete(); } catch { /* Cache cleanup must not mask attachment errors. */ }
    }
  }
  if (mimeType.startsWith("image/")) return {
    ...pending,
    name,
    mimeType,
    size,
    uri: `data:${mimeType};base64,${dataBase64}`,
    lifecycle: "ready",
    error: null,
    metadata: { ...pending.metadata, source: "native-inline", transport: "inline-image-url" },
  };
  // Once the Host request is sent, aborting only the client-side wait can
  // orphan a file that the Host finishes staging. Let the reply arrive so the
  // attachment session can release its ref when the picker item was removed.
  const staged = await staging!.stage({
    clientAttachmentId: pending.id,
    name,
    mimeType,
    size,
    source: { kind: "client-bytes", dataBase64 },
  });
  return {
    ...pending,
    name: staged.ref.name,
    mimeType: staged.ref.mimeType,
    size: staged.ref.size,
    uri: staged.ref.location.kind === "host-file"
      ? hostFileUri(staged.ref.location.path)
      : staged.ref.location.url,
    lifecycle: "ready",
    error: null,
    metadata: { ...pending.metadata, source: "native-host-staged", transport: "opencraft-attachment-staging", attachmentRef: staged.ref },
  };
}
