import { DOCUMENT_MAX_BYTES, type DocumentRecord, type DocumentCommit, type DocumentValue } from "@opencraft/document-storage";

/** First-party Host extension; never edit the upstream-generated protocol for this. */
export const HOST_STORAGE = {
  capabilities: "storage/documents/capabilities",
  read: "storage/documents/read",
  compareAndSet: "storage/documents/compareAndSet",
  changed: "storage/documents/changed",
} as const;
export interface HostStorageCapabilities {
  readonly protocolVersion: 1;
  readonly authority: "host-session";
  readonly maxDocumentBytes: number;
}
export const HOST_STORAGE_CAPABILITIES: HostStorageCapabilities = Object.freeze({ protocolVersion: 1, authority: "host-session", maxDocumentBytes: DOCUMENT_MAX_BYTES });
export interface HostDocumentRead { readonly scope: string }
export interface HostDocumentWrite extends HostDocumentRead { readonly revision: number; readonly version: number; readonly value: DocumentValue }
export type HostDocumentReadResult = DocumentRecord | null;
export type HostDocumentWriteResult = DocumentCommit;
export interface HostDocumentChanged { readonly scope: string; readonly revision: number }

export function parseHostStorageCapabilities(input: unknown): HostStorageCapabilities {
  const value = input as Partial<HostStorageCapabilities> | null;
  if (!value || value.protocolVersion !== 1 || value.authority !== "host-session" || !Number.isSafeInteger(value.maxDocumentBytes) || Number(value.maxDocumentBytes) <= 0) {
    throw new Error("Host document storage is unsupported or incompatible");
  }
  return { protocolVersion: 1, authority: "host-session", maxDocumentBytes: value.maxDocumentBytes! };
}
