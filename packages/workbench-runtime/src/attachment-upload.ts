import {
  ATTACHMENT_CHUNK_BYTES,
  type AttachmentUploadParams, type AttachmentUploadResponse, type AttachmentStageResponse,
} from "@opencraft/appserver-protocol";

export interface AttachmentChunkPort {
  readonly chunkBytes: number;
  uploadChunk(params: AttachmentUploadParams): Promise<AttachmentUploadResponse>;
  uploadCancel(uploadId: string): Promise<{ removed: boolean }>;
}

/** Web and native supply bounded reads; this owner preserves ack/cancel/ref semantics. */
export async function uploadAttachmentChunks(
  metadata: Omit<AttachmentUploadParams, "uploadId" | "offset" | "dataBase64">,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  port: AttachmentChunkPort,
  signal?: AbortSignal,
): Promise<AttachmentStageResponse> {
  const uploadId = crypto.randomUUID();
  const chunkBytes = Math.min(port.chunkBytes, ATTACHMENT_CHUNK_BYTES);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("Invalid attachment chunk size");
  try {
    for (let offset = 0; offset < metadata.size; offset += chunkBytes) {
      signal?.throwIfAborted();
      const bytes = await read(offset, Math.min(chunkBytes, metadata.size - offset));
      signal?.throwIfAborted();
      if (bytes.length !== Math.min(chunkBytes, metadata.size - offset)) throw new Error("Attachment file changed while reading");
      let binary = "";
      for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
      // Always receive the acknowledgement, especially the final committed ref.
      // The Draft can then release it if cancellation raced the final write.
      const response = await port.uploadChunk({ ...metadata, uploadId, offset, dataBase64: btoa(binary) });
      if (response.receivedBytes !== offset + bytes.length) throw new Error("Attachment upload acknowledgement does not match");
      if (response.ref) {
        if (response.receivedBytes !== metadata.size) throw new Error("Attachment upload finished before all bytes were received");
        return { ref: response.ref };
      }
    }
    throw new Error("Attachment upload did not return a committed file");
  } catch (error) {
    await port.uploadCancel(uploadId).catch(() => undefined);
    throw error;
  }
}
