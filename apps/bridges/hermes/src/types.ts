export type JsonRpcId = string | number;
export interface JsonRpcRequest { jsonrpc?: "2.0"; id: JsonRpcId; method: string; params?: unknown }

export interface HermesSessionSummary { id: string; title: string; preview: string; started_at: number; message_count: number; source: string }
export interface HermesMessage { role: string; text?: string; content?: unknown; row_id?: number; _row_id?: number; [key: string]: unknown }
export interface HermesSessionPayload {
  session_id: string; stored_session_id?: string; resumed?: string; message_count: number; messages: HermesMessage[];
  running?: boolean; status?: string; info?: { cwd?: string; model?: string; provider?: string; [key: string]: unknown };
}

export interface AppServerThreadItem { id: string; type: string; [key: string]: unknown }
export interface QueuedSubmission {
  id: string;
  input: unknown[];
  clientUserMessageId: string;
}
export interface AppServerTurn {
  id: string; items: AppServerThreadItem[]; itemsView: "full" | "summary" | "notLoaded";
  status: "completed" | "interrupted" | "failed" | "inProgress"; error: unknown;
  startedAt: number | null; completedAt: number | null; durationMs: number | null;
}
export interface AppServerThread {
  id: string; extra: Record<string, unknown> | null; sessionId: string; forkedFromId: string | null; parentThreadId: string | null;
  preview: string; ephemeral: boolean; section: null; sectionEnteredAt: null; projectId: null; historyMode: "paginated";
  modelProvider: string; createdAt: number; updatedAt: number; recencyAt: number;
  status: { type: "idle" | "active" | "notLoaded"; activeFlags?: unknown[] }; path: null; cwd: string; cliVersion: string;
  source: { custom: string }; canAcceptDirectInput: boolean; threadSource: null; agentNickname: null; agentRole: null;
  gitInfo: null; name: string | null; turns: AppServerTurn[];
}
