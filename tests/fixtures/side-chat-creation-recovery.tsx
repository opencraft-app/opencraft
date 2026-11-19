import React from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { SideChatService } from "@opencraft/workbench-runtime";
import { createConversationKey } from "@opencraft/chat-core";
import { createSideChatPanelPlugin } from "../../apps/workbench-web/src/panels/side-chat-panel-plugin";
const parent = createConversationKey("host", "parent");
let unavailable = true,
  forks = 0;
const ctx = new Context();
const persistence = {
  list: () => [],
  put: () => {
    if (unavailable) throw new Error("Directory save failed. Retry to keep this side chat.");
  },
  remove: () => {},
};
const runtime: any = {
  resources: {
    threads: {
      fork: async () => ({ id: `child-${++forks}` }),
      injectItems: async () => {},
      unsubscribe: async () => {},
    },
  },
  acquireThread: async () => ({ release() {}, getSnapshot: () => ({ activeTurn: null }) }),
};
await ctx.plugin(SideChatService, { resolveHost: async () => runtime, persistence });
try {
  await ctx.sideChats.open("attempt", parent, null);
} catch {}
let Component: any;
const noop = () => () => {};
createSideChatPanelPlugin(
  ctx.sideChats,
  { resolve: () => ({ conversationKey: parent }) } as any,
  () => null,
)({
  workbenchPanels: { register: noop, registerToolbarAction: noop },
  workbenchPanelRenderers: {
    register: (value: any) => {
      Component = value.Component;
      return () => {};
    },
  },
  effect: () => {},
} as any);
(window as any).recovery = {
  allow: () => {
    unavailable = false;
  },
  forks: () => forks,
  success: () => !!ctx.sideChats.get("attempt"),
};
createRoot(document.getElementById("root")!).render(<Component tab={{ resource: "attempt" }} active ownerId="owner" />);
