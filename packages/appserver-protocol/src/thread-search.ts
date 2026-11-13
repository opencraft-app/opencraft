/** Recorded metadata only. No title extraction, Native search, or aggregate count. */
export const THREAD_SEARCH_CAPABILITY = 'opencraft/recorded-name-search';
export const THREAD_SEARCH_METHOD = 'opencraft/thread-directory/search-names';
export const THREAD_SEARCH_MODE = 'recorded-name-v1';
export function recordedNameQuery(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 512) throw new Error('Invalid name query');
  return value.normalize('NFC'); // Case-sensitive literal substring, independent of locale.
}
/** Internal owner fence. Never exposed to CLI or accepted as an execution credential. */
export interface RecordedNameFence { lifetime: string; revision: number; sync: string; upper: number; position: number }
export type RecordedNameRead = { kind: 'window'; query: string; cursor: RecordedNameFence | null } |
  { kind: 'validate'; cursor: RecordedNameFence };
export interface RecordedNameWindow {
  entries: { position: number; threadId: string; name: string }[];
  fence: RecordedNameFence; observedAt: number;
}
export interface ConversationThreadSearch {
  serverId: string; field: 'name'; mode: typeof THREAD_SEARCH_MODE;
  scope: 'authorized-recorded-names'; source: 'host-thread-directory';
  coverage: 'recorded-only'; consistency: 'revision-bound';
  observedAt: number; entries: { ref: import('./collaboration').ConversationRef; name: string }[];
  nextCursor: string | null; complete: boolean;
  count: { status: 'unknown'; value: null; unit: 'threads' };
}
