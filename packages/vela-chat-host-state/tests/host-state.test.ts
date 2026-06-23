import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryKeyValueStore,
  createVelaClientStateStore,
  createVelaShellLayoutStore,
} from "../src";

test("client state store separates conversation scroll and composer draft namespaces", () => {
  const kv = createMemoryKeyValueStore();
  const store = createVelaClientStateStore(kv, { hostId: "desktop-a" });

  store.conversationScroll.write("ses_1", {
    routeKey: "ses_1",
    scrollTop: 128,
    followOutput: false,
  });
  store.composerDraft.write("ses_1", {
    sessionId: "ses_1",
    text: "private draft",
    updatedAt: 42,
  });

  assert.equal(
    kv.getItem("vela-chat:client-state:desktop-a:conversation_scroll:ses_1"),
    '{"version":1,"route_key":"ses_1","scroll_top":128,"follow_output":false}',
  );
  assert.equal(
    kv.getItem("vela-chat:client-state:desktop-a:composer_draft:ses_1"),
    '{"version":1,"session_id":"ses_1","text":"private draft","updated_at":42}',
  );
  assert.deepEqual(store.conversationScroll.read("ses_1"), {
    routeKey: "ses_1",
    scrollTop: 128,
    followOutput: false,
  });
  assert.deepEqual(store.composerDraft.read("ses_1"), {
    sessionId: "ses_1",
    text: "private draft",
    updatedAt: 42,
  });
});

test("client state store drops invalid or mismatched scoped records", () => {
  const kv = createMemoryKeyValueStore({
    "vela-chat:client-state:web:conversation_scroll:ses_1":
      '{"version":1,"route_key":"other","scroll_top":128,"follow_output":false}',
    "vela-chat:client-state:web:composer_draft:ses_1":
      '{"version":1,"session_id":"ses_1","text":7,"updated_at":42}',
  });
  const store = createVelaClientStateStore(kv);

  assert.equal(store.conversationScroll.read("ses_1"), null);
  assert.equal(store.composerDraft.read("ses_1"), null);
});

test("shell layout store is host scoped and separate from chat client state", () => {
  const kv = createMemoryKeyValueStore();
  const shellLayout = createVelaShellLayoutStore(kv, { hostId: "desktop-a" });

  shellLayout.write({
    isSidebarVisible: false,
    sidebarWidthPx: 344,
    updatedAt: 99,
  });

  assert.equal(
    kv.getItem("vela-chat:shell-layout:desktop-a"),
    '{"version":1,"sidebar_width_px":344,"is_sidebar_visible":false,"updated_at":99}',
  );
  assert.deepEqual(shellLayout.read(), {
    isSidebarVisible: false,
    sidebarWidthPx: 344,
    updatedAt: 99,
  });
});
