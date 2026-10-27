export const ATTACHMENT_MAX_BYTES = 1024 * 1024 * 1024;
export const ATTACHMENT_LEGACY_MAX_BYTES = 32 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;

/** Host extension for staging client-selected files into Agent-readable storage. */
export const OPENCRAFT_ATTACHMENT_STAGING_EXTENSION =
  "opencraft/attachment-staging";

export type AttachmentStageSource =
  | { readonly kind: "client-bytes"; readonly dataBase64: string }
  | { readonly kind: "host-path"; readonly path: string };

export type AttachmentLocation =
  | { readonly kind: "host-file"; readonly path: string }
  | {
      readonly kind: "object-url";
      readonly url: string;
      readonly expiresAtMs?: number | null;
    };

export interface AttachmentStagingCapability {
  readonly version: 1;
  /** Optional, negotiated file upload RPC; old Hosts keep the one-shot path. */
  readonly chunkBytes?: number;
  readonly sources: readonly AttachmentStageSource["kind"][];
  readonly locations: readonly AttachmentLocation["kind"][];
  readonly maxBytes: number;
}

export interface AttachmentStageParams {
  readonly clientAttachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly source: AttachmentStageSource;
}

export interface AttachmentRef {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly location: AttachmentLocation;
}

export interface AttachmentStageResponse {
  readonly ref: AttachmentRef;
}

export interface AttachmentRemoveParams {
  readonly id: string;
}

export interface AttachmentRemoveResponse {
  readonly removed: boolean;
}

export interface AttachmentUploadParams extends Omit<AttachmentStageParams, "source"> {
  readonly uploadId: string;
  readonly offset: number;
  readonly dataBase64: string;
}
export interface AttachmentUploadResponse {
  readonly receivedBytes: number;
  readonly ref: AttachmentRef | null;
}

export interface AppServerAttachmentMethodMap {
  "attachment/uploadChunk": { params: AttachmentUploadParams; result: AttachmentUploadResponse };
  "attachment/uploadCancel": { params: { uploadId: string }; result: { removed: boolean } };
  "attachment/stage": {
    params: AttachmentStageParams;
    result: AttachmentStageResponse;
  };
  "attachment/remove": {
    params: AttachmentRemoveParams;
    result: AttachmentRemoveResponse;
  };
}

const SOURCE_KINDS = new Set<AttachmentStageSource["kind"]>([
  "client-bytes",
  "host-path",
]);
const LOCATION_KINDS = new Set<AttachmentLocation["kind"]>([
  "host-file",
  "object-url",
]);

export function parseAttachmentStagingCapability(
  input: unknown,
): AttachmentStagingCapability {
  const value = input as Partial<AttachmentStagingCapability> | null;
  const sources = Array.isArray(value?.sources)
    ? value.sources.filter(
        (item): item is AttachmentStageSource["kind"] =>
          typeof item === "string" && SOURCE_KINDS.has(item as AttachmentStageSource["kind"]),
      )
    : [];
  const locations = Array.isArray(value?.locations)
    ? value.locations.filter(
        (item): item is AttachmentLocation["kind"] =>
          typeof item === "string" && LOCATION_KINDS.has(item as AttachmentLocation["kind"]),
      )
    : [];
  if (
    value?.version !== 1 ||
    sources.length === 0 ||
    sources.length !== value.sources?.length ||
    locations.length === 0 ||
    locations.length !== value.locations?.length ||
    !Number.isSafeInteger(value.maxBytes) ||
    Number(value.maxBytes) <= 0
  ) {
    throw new Error("Attachment staging is unsupported or incompatible");
  }
  return {
    version: 1,
    sources,
    locations,
    maxBytes: Number(value.maxBytes),
    ...(Number.isSafeInteger(value.chunkBytes) && Number(value.chunkBytes) > 0
      && Number(value.chunkBytes) <= ATTACHMENT_CHUNK_BYTES ? { chunkBytes: Number(value.chunkBytes) } : {}),
  };
}
