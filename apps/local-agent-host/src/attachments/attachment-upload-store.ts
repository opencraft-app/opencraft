import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_BYTES,
  type AttachmentUploadParams, type AttachmentUploadResponse, type AttachmentStageResponse,
} from "@opencraft/appserver-protocol";

type Upload = {
  request: AttachmentUploadParams;
  directory: string;
  path: string;
  received: number;
  hash: ReturnType<typeof createHash>;
  timer: ReturnType<typeof setTimeout>;
};
type Commit = (request: AttachmentUploadParams, path: string, sha256: string) => Promise<AttachmentStageResponse>;

/** Bounded per-chunk memory; only committed refs leave the Host. No resumable-upload claim. */
export class AttachmentUploadStore {
  private readonly uploads = new Map<string, Upload>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private closed = false;
  private admissions = 0;
  constructor(private readonly root: string, private readonly commit: Commit) {}

  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(id)) throw new Error("Invalid upload identity");
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.operations.set(id, next);
    void next.finally(() => { if (this.operations.get(id) === next) this.operations.delete(id); }).catch(() => undefined);
    return next;
  }

  private async discard(id: string) {
    const upload = this.uploads.get(id);
    if (!upload) return { removed: false };
    this.uploads.delete(id);
    clearTimeout(upload.timer);
    await rm(upload.directory, { recursive: true, force: true });
    return { removed: true };
  }

  private expiry(id: string) {
    const timer = setTimeout(() => { void this.cancel(id).catch(() => undefined); }, 10 * 60_000);
    timer.unref();
    return timer;
  }

  async chunk(request: AttachmentUploadParams): Promise<AttachmentUploadResponse> {
    if (!request || typeof request !== "object") throw new Error("Invalid upload");
    return this.serial(request.uploadId, async () => {
      if (this.closed) throw new Error("Attachment upload store is closed");
      if (typeof request.clientAttachmentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.clientAttachmentId)
        || typeof request.name !== "string" || !request.name.length || request.name.length > 255
        || typeof request.mimeType !== "string" || request.mimeType.length > 255
        || !Number.isSafeInteger(request.size) || request.size <= 0 || request.size > ATTACHMENT_MAX_BYTES
        || !Number.isSafeInteger(request.offset) || request.offset < 0) throw new Error("Invalid attachment upload metadata or size");
      const encoded = request.dataBase64;
      if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4
        || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error("Invalid attachment chunk");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length > ATTACHMENT_CHUNK_BYTES || bytes.toString("base64") !== encoded
        || request.offset + bytes.length > request.size) throw new Error("Invalid attachment chunk size or encoding");
      let upload = this.uploads.get(request.uploadId);
      if (!upload) {
        if (request.offset !== 0) throw new Error("Attachment upload offset does not match");
        if (this.uploads.size + this.admissions >= 8) throw new Error("Too many active attachment uploads");
        this.admissions++;
        try {
          await mkdir(this.root, { recursive: true, mode: 0o700 });
          const directory = await mkdtemp(join(this.root, "upload-"));
          upload = { request: { ...request, dataBase64: "" }, directory, path: join(directory, "content"), received: 0,
            hash: createHash("sha256"), timer: this.expiry(request.uploadId) };
          this.uploads.set(request.uploadId, upload);
        } finally { this.admissions--; }
      }
      if (upload.received !== request.offset || upload.request.clientAttachmentId !== request.clientAttachmentId
        || upload.request.name !== request.name || upload.request.mimeType !== request.mimeType || upload.request.size !== request.size) {
        throw new Error("Attachment upload metadata or offset does not match");
      }
      clearTimeout(upload.timer);
      try {
        const file = await open(upload.path, request.offset === 0 ? "wx" : "a", 0o600);
        try { await file.writeFile(bytes); } finally { await file.close(); }
        upload.hash.update(bytes);
        upload.received += bytes.length;
        if (upload.received === request.size) {
          const result = await this.commit(request, upload.path, upload.hash.digest("hex"));
          return { receivedBytes: upload.received, ref: result.ref };
        }
        upload.timer = this.expiry(request.uploadId);
        return { receivedBytes: upload.received, ref: null };
      } catch (error) {
        await this.discard(request.uploadId);
        throw error;
      } finally {
        if (upload.received === request.size) await this.discard(request.uploadId);
      }
    });
  }

  async cancel(id: string) { return this.serial(id, () => this.discard(id)); }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.operations.values()]);
    await Promise.all([...this.uploads.keys()].map(id => this.discard(id)));
  }
}
