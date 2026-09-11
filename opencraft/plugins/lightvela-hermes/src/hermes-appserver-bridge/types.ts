export type JsonRpcId = string | number;
export interface JsonRpcRequest { jsonrpc?: "2.0"; id: JsonRpcId; method: string; params?: unknown }
export interface JsonRpcSuccess { jsonrpc?: "2.0"; id: JsonRpcId; result: unknown }
export interface JsonRpcFailure {
  jsonrpc?: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export interface AppServerNotification { jsonrpc: "2.0"; method: string; params: unknown }
export interface AppServerServerRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params: unknown;
}
export type AppServerOutboundMessage = AppServerNotification | AppServerServerRequest;

export interface HermesClarifyQuestion {
  qid?: string;
  question: string;
  choices?: unknown;
  multi_select?: boolean;
}

export interface HermesPendingClarify {
  request_id: string;
  question?: string;
  choices?: unknown;
  multi_select?: boolean;
  questions?: unknown;
  answers?: unknown;
}

export interface HermesSessionSummary {
  id: string;
  /** Compression-lineage tip returned by exact-title registry lookups. */
  resolved_id?: string;
  title: string;
  root_title?: string;
  preview: string;
  started_at: number;
  message_count: number;
  source: string;
  profile?: string;
}
export interface HermesMessage {
  role: string;
  text?: string;
  content?: unknown;
  row_id?: number;
  _row_id?: number;
  /** Durable Hermes message time in Unix seconds, with optional fractions. */
  timestamp?: number;
  [key: string]: unknown;
}
export interface HermesSessionPayload {
  session_id: string; stored_session_id?: string; resumed?: string; message_count: number; messages: HermesMessage[];
  running?: boolean; status?: string; info?: { cwd?: string; model?: string; provider?: string; [key: string]: unknown };
  /** Server-owned blocking prompt replayed by session.resume after reconnect. */
  pending_clarify?: HermesPendingClarify;
  turn_started_at?: number;
  inflight?: {
    user?: string; assistant?: string; streaming?: boolean;
    corrections?: string[]; correction_offsets?: number[];
    error?: string; status?: string; recoverable?: boolean;
    error_surface?: Record<string, unknown>;
  } | null;
  queued?: { user?: string } | null;
}

export interface HermesProfileSummary {
  name: string;
  display_name?: string;
  title?: string | null;
  description?: string;
  has_avatar?: boolean;
  ui_meta?: Record<string, unknown>;
  ui_meta_revisions?: Record<string, number>;
  /** Recent-session hints are profile-owned server indexes, never UI state. */
  last_session?: HermesSessionSummary | null;
  canonical_session?: HermesSessionSummary | null;
}

export interface HermesModelCapabilities {
  fast?: boolean;
  reasoning?: boolean;
  can_disable_reasoning?: boolean;
}

export interface HermesModelProviderOption {
  slug: string;
  name: string;
  models?: string[];
  is_current?: boolean;
  authenticated?: boolean;
  warning?: string;
  capabilities?: Record<string, HermesModelCapabilities>;
}

export interface HermesModelOptionsPayload {
  model?: string;
  provider?: string;
  providers?: HermesModelProviderOption[];
}

export interface AppServerModel {
  id: string;
  model: string;
  upgrade: null;
  upgradeInfo: null;
  availabilityNux: null;
  displayName: string;
  description: string;
  modelSpecialty: null;
  hidden: boolean;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
  defaultReasoningEffort: string;
  inputModalities: Array<"text" | "image" | "audio">;
  supportsPersonality: boolean;
  multiAgentVersion: null;
  additionalSpeedTiers: string[];
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: null;
  isDefault: boolean;
}

export interface HermesMessagesPagination {
  limit: number;
  offset: number;
  order: "latest" | "oldest";
  returned: number;
}

export interface HermesMessagesPage {
  session_id: string;
  messages: HermesMessage[];
  pagination?: HermesMessagesPagination;
}

export interface AppServerThreadItem { id: string; type: string; [key: string]: unknown }
export interface QueuedSubmission {
  id: string;
  input: unknown[];
  clientUserMessageId: string;
  createdAt: number;
  pausedReason: string | null;
}
export interface AppServerTurn {
  id: string; items: AppServerThreadItem[]; itemsView: "full" | "summary" | "notLoaded";
  status: "completed" | "interrupted" | "failed" | "inProgress"; error: unknown;
  startedAt: number | null; completedAt: number | null; durationMs: number | null;
}
export interface AppServerThread {
  id: string; extra: Record<string, unknown> | null; sessionId: string; forkedFromId: string | null; parentThreadId: string | null;
  preview: string; ephemeral: boolean; section: null; sectionEnteredAt: null; projectId: null; historyMode: "message-window";
  modelProvider: string; createdAt: number; updatedAt: number; recencyAt: number;
  status: { type: "idle" | "active" | "notLoaded"; activeFlags?: unknown[] }; path: null; cwd: string; cliVersion: string;
  source: { custom: string }; canAcceptDirectInput: boolean; threadSource: null; agentNickname: null; agentRole: null;
  gitInfo: null; name: string | null; turns: AppServerTurn[];
}
