import type { ConversationHistory } from "./conversation-history.js";

type Methods = "publicTextRead" | "observe" | "initialization" | "hasThreads" | "reindex" | "revision" | "read"
  | "itemSourceCursor" | "sourceCursor" | "catalogRevision" | "itemSourceDirection"
  | "itemRangeFence" | "directoryFence" | "directoryEpoch" | "directoryState" | "invalidateDirectory";
/** Synchronous fixtures and the asynchronous storage worker share one contract.
 * No database handle, statement or transaction crosses the thread boundary. */
export type ConversationHistoryPort = { readonly independentReads?: true; close?(): Promise<void>; importResult: HistoryImport } & Pick<ConversationHistory, "scope" | "subscribeCommitted" | "directoryQuery"> & {
  [K in Methods]: (...args: Parameters<ConversationHistory[K]>) => ReturnType<ConversationHistory[K]> | Promise<ReturnType<ConversationHistory[K]>>;
};

export type HistoryImport = (...args: Parameters<ConversationHistory["importResult"]>) => boolean | Promise<boolean>;
