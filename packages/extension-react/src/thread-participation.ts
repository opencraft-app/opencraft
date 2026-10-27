/** Product-owned participation evidence. Core never infers people from avatars or creators. */
export const THREAD_PARTICIPATION_CHANNEL = "threadParticipation";
export interface ThreadParticipation {
  readonly threadId: string;
  readonly participants: readonly string[];
  readonly creator: string | null;
  readonly pending: boolean;
}
export interface ThreadParticipationContribution {
  readonly id: string;
  /** Return only verified rows; omitted rows remain unknown. */
  read(hostId: string, threadIds: readonly string[], signal: AbortSignal): Promise<readonly ThreadParticipation[]>;
}
