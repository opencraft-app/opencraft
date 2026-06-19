export interface VelaChatDebugRow {
  id: string;
  kind: string;
  key: string;
}

export type VelaChatDebugBottomAnchorBlockedReason =
  | "missing_route_request"
  | "waiting_for_history_readiness"
  | "waiting_for_measurable_viewport"
  | "waiting_for_measurable_content"
  | "waiting_for_post_layout_verification";

export type VelaChatDebugRouteResumeStatus =
  | "idle"
  | "pending"
  | "restored";

export interface VelaChatDebugScrollRuntime {
  followOutput: boolean;
  bottomAnchorBlockedReason: VelaChatDebugBottomAnchorBlockedReason | null;
  routeResumeStatus: VelaChatDebugRouteResumeStatus;
  routeResumeScrollTop: number | null;
}

export interface VelaChatDebugConversationRuntime {
  strategy: "web-plain" | "web-partial-virtualized";
  itemCount: number;
  historyVirtualizedCount: number;
  historyMountedCount: number;
  liveHeadCount: number;
  mountedItemCount: number;
  scroll?: VelaChatDebugScrollRuntime | null;
}

export interface VelaChatDebugSnapshotInput {
  baseUrl: string;
  sessionIdInput: string;
  activeSessionId: string;
  workingDirectoryInput?: string;
  draft: string;
  error: string | null;
  streamConnected: boolean;
  isCreatingSession?: boolean;
  isUpdatingAgentConfig?: boolean;
  agentConfig?: unknown;
  backendCount?: number;
  conversation?: VelaChatDebugConversationRuntime | null;
  rows: VelaChatDebugRow[];
  latestEventId?: string | null;
}

export interface VelaChatDebugSnapshot {
  baseUrl: string;
  sessionIdInput: string;
  activeSessionId: string;
  workingDirectoryInput: string;
  draftLength: number;
  error: string | null;
  streamConnected: boolean;
  isCreatingSession: boolean;
  isUpdatingAgentConfig: boolean;
  agentConfig: unknown;
  backendCount: number;
  rowCount: number;
  conversation: VelaChatDebugConversationRuntime | null;
  rows: VelaChatDebugRow[];
  latestEventId: string | null;
}

export interface VelaChatConsoleEvent {
  channel: "vela-chat";
  name: string;
  detail?: unknown;
}

export interface VelaChatDebugApi {
  version: 1;
  getSnapshot: () => VelaChatDebugSnapshot;
  setBaseUrl: (baseUrl: string) => void;
  setSessionId: (sessionId: string) => void;
  setWorkingDirectory: (workingDirectory: string) => void;
  openSession: (sessionId?: string) => void;
  createSession: () => Promise<void>;
  setDraft: (draft: string) => void;
  sendMessage: (text?: string) => Promise<void>;
  reloadTranscript: () => Promise<void>;
  clearError: () => void;
  logSnapshot: () => VelaChatDebugSnapshot;
}

export const VELA_CHAT_DEBUG_SNAPSHOT_ELEMENT_ID = "vela-chat-debug-snapshot";

declare global {
  interface Window {
    __VELA_CHAT_DEBUG__?: VelaChatDebugApi;
  }
}

export function buildVelaChatDebugSnapshot(
  input: VelaChatDebugSnapshotInput,
): VelaChatDebugSnapshot {
  return {
    baseUrl: input.baseUrl,
    sessionIdInput: input.sessionIdInput,
    activeSessionId: input.activeSessionId,
    workingDirectoryInput: input.workingDirectoryInput ?? "",
    draftLength: input.draft.length,
    error: input.error,
    streamConnected: input.streamConnected,
    isCreatingSession: input.isCreatingSession ?? false,
    isUpdatingAgentConfig: input.isUpdatingAgentConfig ?? false,
    agentConfig: input.agentConfig ?? null,
    backendCount: input.backendCount ?? 0,
    rowCount: input.rows.length,
    conversation: input.conversation
      ? {
          ...input.conversation,
          ...(input.conversation.scroll === undefined
            ? {}
            : {
                scroll: input.conversation.scroll
                  ? { ...input.conversation.scroll }
                  : null,
              }),
        }
      : null,
    rows: input.rows.map((row) => ({ ...row })),
    latestEventId: input.latestEventId ?? null,
  };
}

export function createVelaChatConsoleEvent(
  name: string,
  detail?: unknown,
): VelaChatConsoleEvent {
  return { channel: "vela-chat", name, detail };
}

export function logVelaChatConsoleEvent(name: string, detail?: unknown) {
  console.log("[vela-chat]", createVelaChatConsoleEvent(name, detail));
}

export function installVelaChatDebugApi({
  api,
  documentRef = document,
  snapshot,
  windowRef = window,
}: {
  api: VelaChatDebugApi;
  documentRef?: Pick<Document, "documentElement" | "getElementById" | "createElement" | "body" | "head">;
  snapshot: VelaChatDebugSnapshot;
  windowRef?: Window;
}) {
  windowRef.__VELA_CHAT_DEBUG__ = api;
  writeVelaChatDebugDomSnapshot(snapshot, documentRef);
}

export function writeVelaChatDebugDomSnapshot(
  snapshot: VelaChatDebugSnapshot,
  documentRef: Pick<Document, "documentElement" | "getElementById" | "createElement" | "body" | "head"> = document,
) {
  let element = documentRef.getElementById(
    VELA_CHAT_DEBUG_SNAPSHOT_ELEMENT_ID,
  ) as HTMLScriptElement | null;
  if (!element) {
    element = documentRef.createElement("script") as HTMLScriptElement;
    element.id = VELA_CHAT_DEBUG_SNAPSHOT_ELEMENT_ID;
    element.type = "application/json";
    (documentRef.head ?? documentRef.body).appendChild(element);
  }

  element.textContent = JSON.stringify(snapshot);
  documentRef.documentElement.setAttribute("data-vela-chat-debug-ready", "true");
}
