"use client";

import { createBrowserVelaClientStateStore } from "../../../packages/vela-chat-host-state/src";

const CHAT_EXAMPLE_HOST_STATE_ID = "next-chat-example";

export function createChatExampleClientStateStore() {
  return createBrowserVelaClientStateStore({
    hostId: CHAT_EXAMPLE_HOST_STATE_ID,
  });
}
