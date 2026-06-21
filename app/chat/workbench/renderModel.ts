import type {
  ConversationWireView,
  PendingRequestsWireView,
} from "../../../packages/vela-chat-client/src";
import { buildChatRenderModel } from "../../../packages/vela-chat-render-model/src";
import { buildChatSurfaceFromReadModels } from "../../../packages/vela-chat-surface/src";
import { EMPTY_CURSOR_WINDOW, EMPTY_EVENT_CURSOR } from "./constants";

export function buildWorkbenchRenderModel({
  activeSessionId,
  conversation,
  requests,
  streamConnected,
}: {
  activeSessionId: string;
  conversation: ConversationWireView | null;
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
    stream: { connected: streamConnected },
  });
  return buildChatRenderModel(surface, { kind: "desktop_web" });
}
