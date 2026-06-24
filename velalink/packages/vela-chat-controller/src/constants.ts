import type { CursorWindow } from "../../vela-chat-client/src";
import type { ChatSurfaceEventCursor } from "../../vela-chat-surface/src";

export const DEFAULT_VELAD_BASE_URL = "/chat/api/velad/api/v1";

export const EMPTY_EVENT_CURSOR: ChatSurfaceEventCursor = {
  event_id: "",
  epoch: 0,
  seq: 0,
};

export const EMPTY_CURSOR_WINDOW: CursorWindow = {};

