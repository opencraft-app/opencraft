export const THREAD_NOTE_EXCHANGE = "opencraft/thread-note/exchange";
export interface ThreadNoteMethodMap {
  "opencraft/thread-note/exchange": {
    params: { threadId: string; update: string; vector: string };
    result: { update: string };
  };
}
