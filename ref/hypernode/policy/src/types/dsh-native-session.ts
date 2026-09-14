import type { JsonValue } from "./domain.ts";

export interface DshNativeSessionSnapshot {
  sessionId?: string | null;
  header?: Readonly<Record<string, JsonValue>> | null;
}

export interface DshNativeSessionRecord {
  threadId: string;
  sessionId: string;
  header: Readonly<Record<string, JsonValue>>;
  provenance: string;
  updatedAtMs: number;
}

export interface DshNativeSessionStorePort {
  load(threadId: string): DshNativeSessionRecord | null;
  has(threadId: string): boolean;
  currentSessionId(threadId: string): string | null;
  remember(
    threadId: string,
    snapshot: DshNativeSessionSnapshot,
    provenance?: string,
  ): DshNativeSessionRecord;
}
