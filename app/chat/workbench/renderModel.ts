import type {
  ActivityWireView,
  ChatTranscriptWireView,
  PendingRequestsWireView,
} from "../../../packages/vela-chat-client/src";
import { buildChatRenderModel } from "../../../packages/vela-chat-render-model/src";
import { buildChatSurfaceFromReadModels } from "../../../packages/vela-chat-surface/src";
import { EMPTY_CURSOR_WINDOW, EMPTY_EVENT_CURSOR } from "./constants";

export function buildWorkbenchRenderModel({
  activeSessionId,
  transcript,
  activity,
  requests,
  streamConnected,
}: {
  activeSessionId: string;
  transcript: ChatTranscriptWireView | null;
  activity: ActivityWireView | null;
  requests: PendingRequestsWireView | null;
  streamConnected: boolean;
}) {
  const surfaceSessionId = activeSessionId || "unselected";
  const surface = buildChatSurfaceFromReadModels({
    sessionId: surfaceSessionId,
    transcript: transcript ?? {
      session_id: surfaceSessionId,
      rows: [],
      turns: [],
      window: { has_older: false, has_newer: false },
      cursor: EMPTY_EVENT_CURSOR,
    },
    activity: activity ?? {
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
