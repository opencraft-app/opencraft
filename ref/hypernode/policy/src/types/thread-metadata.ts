import type { AppServerIdentity, JsonRpcError } from "./appserver.ts";

export interface ThreadTitleSetOptions {
  actor?: AppServerIdentity | null | undefined;
  source?: string | undefined;
  attributeIfSame?: boolean | undefined;
  expectedRevision?: number | undefined;
  now?: number | undefined;
  persistThread?: boolean | undefined;
  sourceThreadId?: string | null | undefined;
}

export interface ThreadTitleRecord {
  threadId: string;
  text: string;
  revision: number;
  updatedBy: string | null;
  updatedByUsername: string | null;
  updatedAtMs: number;
  source: string;
  sourceThreadId: string | null;
}

export interface ThreadTitleChange {
  threadId: string;
  record: ThreadTitleRecord;
}

export interface ThreadTitlePort {
  onChange(listener: (event: ThreadTitleChange) => void): () => boolean;
  get(threadId: string): ThreadTitleRecord | null;
  text(threadId: string): string | null;
  ensure(
    thread: { id: string; name?: string; preview?: string; ephemeral?: boolean; forkedFromId?: string | null },
    value?: unknown,
    options?: ThreadTitleSetOptions,
  ): ThreadTitleRecord;
  set(threadId: string, value: string, options?: ThreadTitleSetOptions): ThreadTitleRecord;
  inherit(
    sourceThreadId: string,
    destinationThreadId: string,
    options?: ThreadTitleSetOptions,
  ): ThreadTitleRecord;
  remove(threadId: string): void;
}

export interface ThreadSectionAppearance {
  icon: string | null;
  color: string | null;
}

export interface ThreadSection {
  id: string;
  name: string;
  appearance: ThreadSectionAppearance | null;
}

export interface CollaborationModePort {
  fallbackFor(error: JsonRpcError): CollaborationModeListResponse | null;
}

export interface CollaborationModePreset {
  name: string;
  mode: string;
  model: string | null;
  reasoning_effort: string | null;
}

export interface CollaborationModeListResponse {
  data: CollaborationModePreset[];
}
