/** Committed participant state of one Thread, as the storage Worker read it after its write. */
export interface ParticipantProjection {
  readonly threadId: string;
  readonly revision: number;
  readonly creator: string | null;
  readonly participants: readonly string[];
}

export interface ParticipantWrite {
  readonly projection: ParticipantProjection;
  /** True when the committed write changed participants or the creator (and advanced the revision). */
  readonly changed: boolean;
}

export interface ParticipantApply extends ParticipantWrite {
  /** Requested message IDs that are now committed presence rows (newly or already). */
  readonly recorded: readonly string[];
}

/** Calls the main thread sends to the storage Worker. Each runs in arrival order. */
export interface ParticipantStoreMethods {
  load(threadIds: readonly string[]): ParticipantProjection[];
  apply(threadId: string, messageIds: readonly string[], replace: boolean): ParticipantApply;
  recordCreator(threadId: string, loginName: string | null): ParticipantWrite;
  forget(threadId: string): ParticipantWrite;
}

export interface ParticipantStoreData {
  /** The Host database file. The Host's own owner already migrated it. */
  readonly path: string;
}
