import type {
  ConversationWireItem,
  ConversationWireView,
  PendingRequestsWireView,
} from "../../vela-chat-client/src";
import {
  buildChatRenderModel,
  type ChatHostPolicy,
} from "../../vela-chat-render-model/src";
import { buildChatSurfaceFromReadModels } from "../../vela-chat-surface/src";
import { EMPTY_CURSOR_WINDOW, EMPTY_EVENT_CURSOR } from "./constants";

export function buildVelaChatControllerRenderModel({
  activeSessionId,
  conversation,
  hostPolicy = { kind: "desktop_web" },
  requests,
  streamConnected,
}: {
  activeSessionId: string;
  conversation: ConversationWireView | null;
  hostPolicy?: ChatHostPolicy;
  requests: PendingRequestsWireView | null;
  streamConnected: boolean;
}) {
  const surfaceSessionId = activeSessionId || "unselected";
  const surface = buildChatSurfaceFromReadModels({
    sessionId: surfaceSessionId,
    conversation: conversation ?? {
      session_id: surfaceSessionId,
      items: [],
      window: { has_older: false, has_newer: false },
      cursor: EMPTY_EVENT_CURSOR,
    },
    requests: requests ?? { requests: [], cursor: EMPTY_CURSOR_WINDOW },
    stream: {
      connected: streamConnected,
      running: conversation ? conversationHasRunningWork(conversation) : false,
    },
  });
  return buildChatRenderModel(surface, hostPolicy);
}

function conversationHasRunningWork(conversation: ConversationWireView) {
  return conversation.items.some(isRunningConversationItem);
}

function isRunningConversationItem(item: ConversationWireItem) {
  if (item.kind === "turn_meta") return item.status === "running";
  if (item.kind === "agent_work") return item.status === "running" || item.status === "pending";
  if (item.kind === "assistant_message") return item.status === "streaming";
  if (item.kind === "status") return item.status === "pending" || item.status === "streaming";
  return false;
}
