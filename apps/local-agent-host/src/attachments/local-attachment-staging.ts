import { AttachmentUploadStore } from "./attachment-upload-store.js";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_LEGACY_MAX_BYTES, ATTACHMENT_CHUNK_BYTES } from "@opencraft/appserver-protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  AttachmentRef,
  AttachmentRemoveParams,
  AttachmentRemoveResponse,
  AttachmentStageParams,
  AttachmentStageResponse,
  AttachmentStagingCapability,
} from "@opencraft/appserver-protocol";

export const LOCAL_ATTACHMENT_MAX_BYTES = ATTACHMENT_MAX_BYTES;

export const LOCAL_ATTACHMENT_STAGING_CAPABILITY: AttachmentStagingCapability =
  Object.freeze({
    version: 1,
    chunkBytes: ATTACHMENT_CHUNK_BYTES,
    sources: ["client-bytes"] as const,
    locations: ["host-file"] as const,
    maxBytes: LOCAL_ATTACHMENT_MAX_BYTES,
  });

interface AttachmentManifest {
  readonly protocolVersion: 1;
  readonly ref: AttachmentRef;
  readonly contentSha256: string;
}

const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function safeAttachmentFilename(value: string): string {
  const name = value
    .normalize("NFKC")
    .replace(/[\\/\0]/gu, "-")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 180);
  return name || "attachment";
}

function decodeBase64(value: string): Buffer {
  if (/\s/u.test(value)) throw new Error("Attachment bytes are not valid base64");
  const normalized = value;
  if (
    normalized.length === 0 ||
    normalized.length > Math.ceil(ATTACHMENT_LEGACY_MAX_BYTES / 3) * 4 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
  ) {
    throw new Error("Attachment bytes are not valid base64");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (
    bytes.toString("base64").replace(/=+$/u, "") !==
    normalized.replace(/=+$/u, "")
  ) {
    throw new Error("Attachment bytes are not valid base64");
  }
  return bytes;
}

export function validateAttachmentIdentity(id: string): void {
  if (!ATTACHMENT_ID.test(id)) {
    throw new Error("Invalid attachment identity");
  }
}

/** Shared admission for local storage and SSH staging; transport never relaxes it. */
export function validateClientAttachment(request: AttachmentStageParams): { bytes: Buffer; contentSha256: string } {
  validateAttachmentIdentity(request.clientAttachmentId);
  if (typeof request.name !== "string" || request.name.length === 0 || request.name.length > 255) {
    throw new Error("Attachment name must contain 1 to 255 characters");
  }
  if (typeof request.mimeType !== "string" || request.mimeType.length > 255) throw new Error("Attachment MIME type is invalid");
  if (request.source?.kind !== "client-bytes") throw new Error("Unsupported attachment source");
  if (!Number.isSafeInteger(request.size) || request.size <= 0) throw new Error("Attachment size must be a positive integer");
  if (request.size > ATTACHMENT_LEGACY_MAX_BYTES) throw new Error(`Attachment exceeds one-shot limit of ${ATTACHMENT_LEGACY_MAX_BYTES} bytes; use chunked upload`);
  if (typeof request.source.dataBase64 !== "string") throw new Error("Attachment bytes are not valid base64");
  const bytes = decodeBase64(request.source.dataBase64);
  if (bytes.byteLength !== request.size) throw new Error("Attachment size does not match its bytes");
  return { bytes, contentSha256: createHash("sha256").update(bytes).digest("hex") };
}

function sameRequest(manifest: AttachmentManifest, request: Omit<AttachmentStageParams, "source">): boolean {
  return manifest.protocolVersion === 1
    && manifest.ref.id === request.clientAttachmentId
    && manifest.ref.name === request.name
    && manifest.ref.mimeType === request.mimeType
    && manifest.ref.size === request.size
    && manifest.ref.location.kind === "host-file";
}

export class LocalAttachmentStagingService {
  readonly capability = LOCAL_ATTACHMENT_STAGING_CAPABILITY;
  private readonly root: string;
  private readonly uploads: AttachmentUploadStore;

  constructor(root: string) {
    this.root = resolve(root);
    this.uploads = new AttachmentUploadStore(join(this.root, ".uploads"), (request, path, hash) => this.commitFile(request, hash, path));
  }

  /** Resolve only a file this staging owner actually committed. Other mentions are not ours. */
  async referenceForHostPath(name: string, candidatePath: string): Promise<AttachmentRef | null> {
    if (!isAbsolute(candidatePath)) return null;
    const filePath = resolve(candidatePath);
    const ownedPath = relative(this.root, filePath);
    if (ownedPath === "" || ownedPath.startsWith("..") || isAbsolute(ownedPath)) return null;
    const [id, filename, extra] = ownedPath.split(sep);
    if (!id || !filename || extra !== undefined || !filename.startsWith("content-")) {
      throw new Error("Invalid staged attachment path");
    }
    validateAttachmentIdentity(id);
    const manifest = JSON.parse(await readFile(join(this.root, id, "manifest.json"), "utf8")) as AttachmentManifest;
    if (manifest.protocolVersion !== 1 || manifest.ref.id !== id || manifest.ref.name !== name
      || manifest.ref.location.kind !== "host-file" || resolve(manifest.ref.location.path) !== filePath) {
      throw new Error("Staged attachment reference does not match its manifest");
    }
    const file = await lstat(filePath);
    if (!file.isFile() || file.size !== manifest.ref.size) {
      throw new Error("Staged attachment bytes are unavailable");
    }
    return manifest.ref;
  }

  async stage(request: AttachmentStageParams): Promise<AttachmentStageResponse> {
    const { bytes, contentSha256 } = validateClientAttachment(request);
    return this.commitFile(request, contentSha256, bytes);
  }

  private async commitFile(request: Omit<AttachmentStageParams, "source">, contentSha256: string, source: Buffer | string): Promise<AttachmentStageResponse> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = join(this.root, request.clientAttachmentId);
    const manifestPath = join(directory, "manifest.json");
    try {
      const existing = JSON.parse(await readFile(manifestPath, "utf8")) as AttachmentManifest;
      if (!sameRequest(existing, request)) {
        throw new Error("Attachment identity is already staged with different metadata");
      }
      if (existing.contentSha256 !== contentSha256) {
        throw new Error("Attachment identity is already staged with different content");
      }
      if (existing.ref.location.kind !== "host-file") {
        throw new Error("Local attachment manifest has an invalid location");
      }
      const existingPath = resolve(existing.ref.location.path);
      const existingRelative = relative(directory, existingPath);
      if (
        existingRelative === "" ||
        existingRelative.startsWith("..") ||
        isAbsolute(existingRelative)
      ) {
        throw new Error("Local attachment manifest escaped its owned directory");
      }
      const metadata = await stat(existingPath);
      if (!metadata.isFile() || metadata.size !== request.size) {
        throw new Error("Local attachment manifest does not match staged bytes");
      }
      return { ref: existing.ref };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    let ownsDirectory = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      ownsDirectory = true;
      const filePath = join(directory, `content-${safeAttachmentFilename(request.name)}`);
      const partPath = join(directory, `.${randomUUID()}.part`);
      if (typeof source === "string") await rename(source, partPath);
      else await writeFile(partPath, source, { flag: "wx", mode: 0o600 });
      await rename(partPath, filePath);
      const ref: AttachmentRef = {
        id: request.clientAttachmentId,
        name: request.name,
        mimeType: request.mimeType || "application/octet-stream",
        size: request.size,
        location: { kind: "host-file", path: filePath },
      };
      const manifestPart = join(directory, `.${randomUUID()}.manifest.part`);
      await writeFile(
        manifestPart,
        `${JSON.stringify({ protocolVersion: 1, ref, contentSha256 } satisfies AttachmentManifest)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await rename(manifestPart, manifestPath);
      return { ref };
    } catch (error) {
      if (ownsDirectory) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async remove(params: AttachmentRemoveParams): Promise<AttachmentRemoveResponse> {
    validateAttachmentIdentity(params.id);
    const directory = join(this.root, params.id);
    try {
      await rm(directory, { recursive: true });
      return { removed: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: false };
      throw error;
    }
  }

  async close() { await this.uploads.close(); }

  async handle(method: string, params: unknown): Promise<unknown> {
    if (method === "attachment/uploadChunk") return this.uploads.chunk(params as import("@opencraft/appserver-protocol").AttachmentUploadParams);
    if (method === "attachment/uploadCancel") return this.uploads.cancel((params as { uploadId: string }).uploadId);
    if (method === "attachment/stage") {
      return this.stage(params as AttachmentStageParams);
    }
    if (method === "attachment/remove") {
      return this.remove(params as AttachmentRemoveParams);
    }
    throw new Error(`Unsupported attachment method ${method}`);
  }
}

export { AttachmentUploadStore };
