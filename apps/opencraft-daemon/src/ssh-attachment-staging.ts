import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { AttachmentRef, AttachmentStageParams, AttachmentStageResponse } from "@opencraft/appserver-protocol";
import { AttachmentUploadStore, LOCAL_ATTACHMENT_STAGING_CAPABILITY, safeAttachmentFilename, validateAttachmentIdentity, validateClientAttachment } from "@opencraft/local-agent-host/attachments/local-staging";
import type { SshFileTransfer } from "./ssh-file-transfer.js";

export const SSH_ATTACHMENT_SFTP_THRESHOLD = 10 * 1024 * 1024;

export interface SshAttachmentStorage {
  readonly directory: string;
  /** Stable installation Server + endpoint identity, not a connection generation. */
  readonly namespace: string;
  readonly files: Pick<SshFileTransfer, "upload" | "download" | "commit" | "protectDirectory" | "close">;
  readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  readonly isRetained?: (id: string) => boolean;
}

interface Manifest {
  readonly version: 1;
  readonly ref: AttachmentRef;
  readonly contentSha256: string;
  readonly phase: "uploading" | "ready" | "pending-removal";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Hub owns metadata/lifecycle; all Agent-readable bytes belong to the SSH Host. */
export class SshAttachmentStagingService {
  readonly capability = LOCAL_ATTACHMENT_STAGING_CAPABILITY;
  private root: string | null = null;
  private readonly operations = new Map<string, Promise<unknown>>();
  private closed = false;
  private readonly uploads: AttachmentUploadStore;
  constructor(private readonly storage: SshAttachmentStorage) {
    if (!/^[a-f0-9]{32,64}$/u.test(storage.namespace)) throw new Error("Invalid SSH attachment namespace");
    this.uploads = new AttachmentUploadStore(join(storage.directory, ".incoming"), (request, path, hash) => this.stageValidated(request, hash, path));
  }

  initialize(codexHome: unknown): boolean {
    if (typeof codexHome !== "string" || !posix.isAbsolute(codexHome) || /[\r\n\0]/u.test(codexHome)) return false;
    const root = posix.join(codexHome, "attachments", `opencraft-${this.storage.namespace}`);
    if (this.root !== null && this.root !== root) return false;
    this.root = root;
    return true;
  }

  private requireRoot(): string {
    if (this.closed || this.root === null) throw new Error("SSH attachment staging is unavailable");
    return this.root;
  }
  private manifestPath(id: string): string { validateAttachmentIdentity(id); return join(this.storage.directory, `${id}.json`); }
  private remoteDirectory(id: string): string { validateAttachmentIdentity(id); return posix.join(this.requireRoot(), id); }

  private async readManifest(id: string): Promise<Manifest | null> {
    let manifest: Manifest;
    try { manifest = JSON.parse(await readFile(this.manifestPath(id), "utf8")) as Manifest; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (manifest.version !== 1 || manifest.ref?.id !== id || manifest.ref.location?.kind !== "host-file"
      || manifest.ref.location.path !== posix.join(this.remoteDirectory(id), `content-${safeAttachmentFilename(manifest.ref.name)}`)
      || !/^[a-f0-9]{64}$/u.test(manifest.contentSha256)
      || !["uploading", "ready", "pending-removal"].includes(manifest.phase)
      || !Number.isSafeInteger(manifest.ref.size) || manifest.ref.size <= 0 || manifest.ref.size > this.capability.maxBytes) {
      throw new Error("Invalid SSH attachment manifest");
    }
    return manifest;
  }
  private async saveManifest(manifest: Manifest): Promise<void> {
    await mkdir(this.storage.directory, { recursive: true, mode: 0o700 });
    const path = this.manifestPath(manifest.ref.id);
    const part = `${path}.${randomUUID()}.part`;
    try {
      await writeFile(part, JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 });
      await rename(part, path);
    } finally { await rm(part, { force: true }); }
  }

  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    validateAttachmentIdentity(id);
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => { this.requireRoot(); return run(); });
    this.operations.set(id, next);
    void next.finally(() => { if (this.operations.get(id) === next) this.operations.delete(id); }).catch(() => undefined);
    return next;
  }

  private async verify(manifest: Manifest): Promise<void> {
    const path = manifest.ref.location.kind === "host-file" ? manifest.ref.location.path : "";
    const metadata = record(await this.storage.request("fs/getMetadata", { path }));
    if (metadata.isFile !== true || metadata.isSymlink === true) throw new Error("Staged remote attachment is unavailable");
    let bytes: Buffer;
    if (manifest.ref.size <= SSH_ATTACHMENT_SFTP_THRESHOLD) {
      const result = record(await this.storage.request("fs/readFile", { path }));
      if (typeof result.dataBase64 !== "string" || result.dataBase64.length > Math.ceil(SSH_ATTACHMENT_SFTP_THRESHOLD / 3) * 4) {
        throw new Error("Remote attachment verification failed");
      }
      bytes = Buffer.from(result.dataBase64, "base64");
    } else {
      const temp = await mkdtemp(join(this.storage.directory, ".verify-"));
      try {
        const local = join(temp, "content");
        await this.storage.files.download(path, local, manifest.ref.size > 32 * 1024 * 1024 ? 30 * 60_000 : undefined);
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of createReadStream(local)) { size += chunk.length; hash.update(chunk); }
        if (size !== manifest.ref.size || hash.digest("hex") !== manifest.contentSha256) {
          throw new Error("Remote attachment content does not match its committed bytes");
        }
        return;
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
    if (bytes.length !== manifest.ref.size || sha256(bytes) !== manifest.contentSha256) {
      throw new Error("Remote attachment content does not match its committed bytes");
    }
  }

  async stage(request: AttachmentStageParams): Promise<AttachmentStageResponse> {
    // Validate before allocating a remote directory or opening a file transfer.
    const { bytes, contentSha256 } = validateClientAttachment(request);
    return this.stageValidated(request, contentSha256, bytes);
  }

  private async stageValidated(request: Omit<AttachmentStageParams, "source">, contentSha256: string, source: Buffer | string): Promise<AttachmentStageResponse> {
    await this.retryPendingRemovals(request.clientAttachmentId);
    return this.serial(request.clientAttachmentId, async () => {
      const previous = await this.readManifest(request.clientAttachmentId);
      if (previous && (previous.ref.name !== request.name || previous.ref.mimeType !== (request.mimeType || "application/octet-stream")
        || previous.ref.size !== request.size || previous.contentSha256 !== contentSha256)) {
        throw new Error("Attachment identity is already staged with different metadata or content");
      }
      if (previous?.phase === "pending-removal") throw new Error("Attachment removal is pending; retry removing it");
      if (previous?.phase === "ready") { await this.verify(previous); return { ref: previous.ref }; }
      const directory = this.remoteDirectory(request.clientAttachmentId);
      const path = posix.join(directory, `content-${safeAttachmentFilename(request.name)}`);
      const manifest: Manifest = { version: 1, contentSha256, phase: "uploading", ref: {
        id: request.clientAttachmentId, name: request.name, mimeType: request.mimeType || "application/octet-stream",
        size: request.size, location: { kind: "host-file", path },
      } };
      // Persist intent before any remote mutation. Unknown delivery is retried
      // with this exact identity/content, never cleaned up as a guessed failure.
      await this.saveManifest(manifest);
      for (const owned of [this.requireRoot(), directory]) {
        await this.storage.request("fs/createDirectory", { path: owned, recursive: true });
        const meta = record(await this.storage.request("fs/getMetadata", { path: owned }));
        if (meta.isDirectory !== true || meta.isSymlink === true) throw new Error("Remote attachment directory is not owned storage");
        await this.storage.files.protectDirectory(owned);
      }
      const part = posix.join(directory, ".content.part");
      if (typeof source === "string") {
        await this.storage.files.upload(source, part, 30 * 60_000);
      } else if (source.length <= SSH_ATTACHMENT_SFTP_THRESHOLD) {
        await this.storage.request("fs/writeFile", { path: part, dataBase64: source.toString("base64") });
      } else {
        const spool = await mkdtemp(join(this.storage.directory, ".upload-"));
        try {
          const sourcePath = join(spool, "content");
          await writeFile(sourcePath, source, { mode: 0o600 });
          await this.storage.files.upload(sourcePath, part);
        } finally { await rm(spool, { recursive: true, force: true }); }
      }
      await this.storage.files.commit(part, path);
      await this.verify(manifest);
      this.requireRoot(); // Closing during the transfer never publishes ready.
      await this.saveManifest({ ...manifest, phase: "ready" });
      return { ref: manifest.ref };
    });
  }

  async referenceForHostPath(name: string, path: string): Promise<AttachmentRef | null> {
    const root = this.requireRoot();
    if (!posix.isAbsolute(path)) return null;
    const relative = posix.relative(root, posix.normalize(path));
    if (relative === "" || relative.startsWith("../") || posix.isAbsolute(relative)) return null;
    const [id, filename, extra] = relative.split("/");
    if (!id || !filename || extra !== undefined) throw new Error("Invalid staged remote attachment path");
    return this.serial(id, async () => {
      const manifest = await this.readManifest(id);
      if (!manifest || manifest.phase !== "ready" || manifest.ref.name !== name
        || manifest.ref.location.kind !== "host-file" || manifest.ref.location.path !== path) {
        throw new Error("Remote attachment reference is not committed");
      }
      await this.verify(manifest);
      return manifest.ref;
    });
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    return this.serial(id, async () => {
      const manifest = await this.readManifest(id);
      if (!manifest) return { removed: false };
      if (this.storage.isRetained?.(id)) throw new Error("Sent attachments cannot be removed from history");
      await this.saveManifest({ ...manifest, phase: "pending-removal" });
      await this.storage.request("fs/remove", { path: this.remoteDirectory(id), recursive: true, force: true });
      await rm(this.manifestPath(id), { force: true });
      return { removed: true };
    });
  }

  private async retryPendingRemovals(excludeId: string): Promise<void> {
    this.requireRoot();
    let names: string[];
    try { names = await readdir(this.storage.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of names.filter(name => name.endsWith(".json")).slice(0, 128)) {
      const id = name.slice(0, -5);
      if (id === excludeId) continue;
      // Cleanup is best-effort: an unrelated record may belong to an old
      // remote home or be unreadable. Preserve it and keep new uploads usable;
      // direct access still performs the full manifest/path validation.
      const manifest = await this.readManifest(id).catch(() => null);
      if (manifest?.phase === "pending-removal") await this.remove(id).catch(() => undefined);
    }
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    if (method === "attachment/uploadChunk") return this.uploads.chunk(params as import("@opencraft/appserver-protocol").AttachmentUploadParams);
    if (method === "attachment/uploadCancel") return this.uploads.cancel((params as { uploadId: string }).uploadId);
    if (method === "attachment/stage") return this.stage(params as AttachmentStageParams);
    if (method === "attachment/remove") return this.remove(String(record(params).id ?? ""));
    throw new Error("Unsupported SSH attachment method");
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.storage.files.close();
    await this.uploads.close();
    await Promise.allSettled([...this.operations.values()]);
  }
}
