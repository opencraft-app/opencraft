import type {
  AttachmentRef,
  AttachmentRemoveParams,
  AttachmentRemoveResponse,
  AttachmentStageParams,
  AttachmentStageResponse,
  AttachmentStagingCapability,
} from "@opencraft/appserver-protocol";

import type { HermesHostFileSystem } from "./dashboard-file-system";

export const HERMES_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

export const HERMES_ATTACHMENT_STAGING_CAPABILITY: AttachmentStagingCapability =
  Object.freeze({
    version: 1,
    sources: ["client-bytes"] as const,
    locations: ["host-file"] as const,
    maxBytes: HERMES_ATTACHMENT_MAX_BYTES,
  });

interface AttachmentManifest {
  readonly protocolVersion: 1;
  readonly ref: AttachmentRef;
  readonly contentSha256: string;
}

const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function validateIdentity(id: string): void {
  if (!ATTACHMENT_ID.test(id)) throw new Error("Invalid attachment identity");
}

function safeFilename(value: string): string {
  const name = value
    .normalize("NFKC")
    .replace(/[\\/\0]/gu, "-")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 180);
  return name || "attachment";
}

function decodeBase64(value: string, maxBytes = HERMES_ATTACHMENT_MAX_BYTES): Uint8Array {
  if (
    value.length === 0
    || value.length > Math.ceil(maxBytes / 3) * 4
    || value.length % 4 !== 0
    || /\s/u.test(value)
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) throw new Error("Attachment bytes are not valid base64");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Attachment bytes are not valid base64");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const canonical = bytesToBase64(bytes).replace(/=+$/u, "");
  if (canonical !== value.replace(/=+$/u, "")) {
    throw new Error("Attachment bytes are not valid base64");
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function ownedDirectory(fileSystem: HermesHostFileSystem, id: string): string {
  const root = fileSystem.codexHome.replace(/\/+$/u, "");
  return `${root}/opencraft-attachments/${id}`;
}

function sameRequest(manifest: AttachmentManifest, request: AttachmentStageParams): boolean {
  return manifest.protocolVersion === 1
    && manifest.ref.id === request.clientAttachmentId
    && manifest.ref.name === request.name
    && manifest.ref.mimeType === request.mimeType
    && manifest.ref.size === request.size
    && manifest.ref.location.kind === "host-file";
}

function missingFile(error: unknown): boolean {
  return error instanceof Error && /(?:HTTP 404:|path does not exist|Path not found)/iu.test(error.message);
}

export class HermesAttachmentStagingService {
  readonly capability = HERMES_ATTACHMENT_STAGING_CAPABILITY;

  constructor(private readonly fileSystem: HermesHostFileSystem) {}

  async stage(request: AttachmentStageParams): Promise<AttachmentStageResponse> {
    validateIdentity(request.clientAttachmentId);
    if (typeof request.name !== "string" || request.name.length === 0 || request.name.length > 255) {
      throw new Error("Attachment name must contain 1 to 255 characters");
    }
    if (typeof request.mimeType !== "string" || request.mimeType.length > 255) {
      throw new Error("Attachment MIME type is invalid");
    }
    if (request.source.kind !== "client-bytes") {
      throw new Error(`Unsupported Hermes attachment source: ${request.source.kind}`);
    }
    if (!Number.isSafeInteger(request.size) || request.size <= 0) {
      throw new Error("Attachment size must be a positive integer");
    }
    if (request.size > this.capability.maxBytes) {
      throw new Error(`Attachment exceeds ${this.capability.maxBytes} bytes`);
    }
    const bytes = decodeBase64(request.source.dataBase64);
    if (bytes.byteLength !== request.size) throw new Error("Attachment size does not match its bytes");
    const contentSha256 = await sha256(bytes);
    const directory = ownedDirectory(this.fileSystem, request.clientAttachmentId);
    const manifestPath = `${directory}/manifest.json`;
    const existing = await this.readManifest(manifestPath);
    if (existing !== null) {
      if (!sameRequest(existing, request)) {
        throw new Error("Attachment identity is already staged with different metadata");
      }
      if (existing.contentSha256 !== contentSha256) {
        throw new Error("Attachment identity is already staged with different content");
      }
      if (
        existing.ref.location.kind !== "host-file"
        || !existing.ref.location.path.startsWith(`${directory}/`)
      ) throw new Error("Hermes attachment manifest escaped its owned directory");
      const stagedBytes = decodeBase64((await this.fileSystem.readFile(existing.ref.location.path)).dataBase64);
      if (stagedBytes.byteLength !== request.size || await sha256(stagedBytes) !== contentSha256) {
        throw new Error("Hermes attachment manifest does not match staged bytes");
      }
      return { ref: existing.ref };
    }

    const contentPath = `${directory}/content-${safeFilename(request.name)}`;
    const ref: AttachmentRef = {
      id: request.clientAttachmentId,
      name: request.name,
      mimeType: request.mimeType || "application/octet-stream",
      size: request.size,
      location: { kind: "host-file", path: contentPath },
    };
    await this.fileSystem.writeFile(contentPath, request.source.dataBase64);
    const manifest: AttachmentManifest = { protocolVersion: 1, ref, contentSha256 };
    await this.fileSystem.writeFile(
      manifestPath,
      bytesToBase64(new TextEncoder().encode(`${JSON.stringify(manifest)}\n`)),
    );
    return { ref };
  }

  async remove(params: AttachmentRemoveParams): Promise<AttachmentRemoveResponse> {
    validateIdentity(params.id);
    return { removed: await this.fileSystem.remove(ownedDirectory(this.fileSystem, params.id), true) };
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    if (method === "attachment/stage") return this.stage(params as AttachmentStageParams);
    if (method === "attachment/remove") return this.remove(params as AttachmentRemoveParams);
    throw new Error(`Unsupported attachment method ${method}`);
  }

  private async readManifest(path: string): Promise<AttachmentManifest | null> {
    try {
      const bytes = decodeBase64((await this.fileSystem.readFile(path)).dataBase64, 1024 * 1024);
      return JSON.parse(new TextDecoder().decode(bytes)) as AttachmentManifest;
    } catch (error) {
      if (missingFile(error)) return null;
      throw error;
    }
  }
}
