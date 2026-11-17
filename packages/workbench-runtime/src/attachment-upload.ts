import type { TransportSendProgressObserver } from "@opencraft/appserver-client/transport";
import {
  ATTACHMENT_CHUNK_BYTES,
  type AttachmentUploadParams, type AttachmentUploadResponse, type AttachmentStageResponse,
} from "@opencraft/appserver-protocol";

export interface AttachmentChunkPort {
  readonly chunkBytes: number;
  readonly uploadRetry?: "last-chunk-v1";
  uploadChunk(params: AttachmentUploadParams, onSendProgress?: TransportSendProgressObserver, progressSignal?: AbortSignal): Promise<AttachmentUploadResponse>;
  uploadCancel(uploadId: string): Promise<{ removed: boolean }>;
}

export { AttachmentChunkDeadline } from "@opencraft/appserver-client/transport";

/** Web and native supply bounded reads; this owner preserves ack/cancel/ref semantics. */
export async function uploadAttachmentChunks(
  metadata: Omit<AttachmentUploadParams, "uploadId" | "offset" | "dataBase64">,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  port: AttachmentChunkPort,
  signal?: AbortSignal,
  onProgress?: (progress: { readonly loaded: number; readonly total: number; readonly source?: "sent" | "confirmed" }) => void,
): Promise<AttachmentStageResponse> {
  const uploadId = crypto.randomUUID();
  const chunkBytes = Math.min(port.chunkBytes, ATTACHMENT_CHUNK_BYTES);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("Invalid attachment chunk size");
  try {
    signal?.throwIfAborted();
    onProgress?.({ loaded: 0, total: metadata.size });
    for (let offset = 0; offset < metadata.size; offset += chunkBytes) {
      signal?.throwIfAborted();
      const bytes = await read(offset, Math.min(chunkBytes, metadata.size - offset));
      signal?.throwIfAborted();
      if (bytes.length !== Math.min(chunkBytes, metadata.size - offset)) throw new Error("Attachment file changed while reading");
      let binary = "";
      for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
      // Always receive the acknowledgement, especially the final committed ref.
      // The Draft can then release it if cancellation raced the final write.
      let sending = true;
      const request = { ...metadata, uploadId, offset, dataBase64: btoa(binary) };
      const startedAt = Date.now();
      let attempt = 0;
      const send = async (): Promise<AttachmentUploadResponse> => {
        const currentAttempt = attempt;
        try {
          return await port.uploadChunk(attempt ? { ...request, retry: true } : request, onProgress ? progress => {
            if (currentAttempt !== attempt || !sending || signal?.aborted || !Number.isFinite(progress.total) || progress.total <= 0
              || !Number.isFinite(progress.loaded) || progress.loaded < 0 || progress.loaded > progress.total) return;
            // The transport measures the serialized frame, including its envelope.
            // Project a bounded file-byte estimate; only the ref below commits readiness.
            const loaded = offset + Math.floor(bytes.length * progress.loaded / progress.total);
            onProgress?.({ loaded, total: metadata.size, source: "sent" });
          } : undefined, signal);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (port.uploadRetry !== "last-chunk-v1" || signal?.aborted || attempt++ >= 2
            || Date.now() - startedAt >= 5 * 60_000
            || (code !== "TIMEOUT" && code !== "TRANSPORT_ERROR" && code !== "NOT_CONNECTED")) throw error;
          await new Promise<void>(resolve => setTimeout(resolve, attempt * 500));
          signal?.throwIfAborted();
          return send();
        }
      };
      const response = await send().finally(() => { sending = false; });
      if (response.receivedBytes !== offset + bytes.length) throw new Error("Attachment upload acknowledgement does not match");
      if (!signal?.aborted) onProgress?.({ loaded: response.receivedBytes, total: metadata.size, source: "confirmed" });
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
