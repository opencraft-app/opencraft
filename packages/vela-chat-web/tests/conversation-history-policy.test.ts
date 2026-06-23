import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DESKTOP_CONVERSATION_HISTORY_POLICY,
  deriveConversationHistoryPhase,
  shouldAutoPreloadOlderConversation,
} from "../../vela-chat-controller/src/historyPolicy";

test("desktop chat defaults to full conversation history preload", () => {
  assert.equal(DEFAULT_DESKTOP_CONVERSATION_HISTORY_POLICY, "full_preload");
});

test("default desktop history policy preloads older pages and shows the hydration gate", () => {
  assert.equal(
    shouldAutoPreloadOlderConversation({
      policy: DEFAULT_DESKTOP_CONVERSATION_HISTORY_POLICY,
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
    }),
    true,
  );
  assert.equal(
    deriveConversationHistoryPhase({
      policy: DEFAULT_DESKTOP_CONVERSATION_HISTORY_POLICY,
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: null,
    }),
    "hydrating_history",
  );
});

test("full preload triggers while the active conversation has older pages", () => {
  assert.equal(
    shouldAutoPreloadOlderConversation({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
    }),
    true,
  );
});

test("full preload waits for readiness and in-flight loads", () => {
  assert.equal(
    shouldAutoPreloadOlderConversation({
      policy: "full_preload",
      activeSessionId: "",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
    }),
    false,
  );
  assert.equal(
    shouldAutoPreloadOlderConversation({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: false,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
    }),
    false,
  );
  assert.equal(
    shouldAutoPreloadOlderConversation({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: true,
      hasCompletedInitialHydration: false,
    }),
    false,
  );
});

test("tail-only policy keeps older history demand driven", () => {
  assert.equal(
    shouldAutoPreloadOlderConversation({
      policy: "tail_only",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
    }),
    false,
  );
});

test("full preload enters history hydration only during initial conversation hydration", () => {
  assert.equal(
    deriveConversationHistoryPhase({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: null,
    }),
    "hydrating_history",
  );
  assert.equal(
    deriveConversationHistoryPhase({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: false,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: null,
    }),
    "ready",
  );
  assert.equal(
    deriveConversationHistoryPhase({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: false,
      hasOlder: true,
      isLoadingOlder: true,
      hasCompletedInitialHydration: true,
      error: null,
    }),
    "ready",
  );
});

test("full preload does not restart older-page preload after initial hydration completed", () => {
  assert.equal(
    shouldAutoPreloadOlderConversation({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: true,
    }),
    false,
  );
});

test("full preload remembers completed hydration per session across tab switches", async () => {
  const module = (await import("../../vela-chat-controller/src/historyPolicy")) as Record<
    string,
    unknown
  >;
  const rememberCompletedConversationHistoryHydration =
    module.rememberCompletedConversationHistoryHydration as
      | ((completedSessionIds: ReadonlySet<string>, sessionId: string) => ReadonlySet<string>)
      | undefined;
  const hasCompletedConversationHistoryHydration =
    module.hasCompletedConversationHistoryHydration as
      | ((completedSessionIds: ReadonlySet<string>, sessionId: string) => boolean)
      | undefined;

  assert.equal(typeof rememberCompletedConversationHistoryHydration, "function");
  assert.equal(typeof hasCompletedConversationHistoryHydration, "function");

  const afterSessionA = rememberCompletedConversationHistoryHydration?.(
    new Set(),
    "sess_a",
  );
  assert.ok(afterSessionA);
  const afterSessionB = rememberCompletedConversationHistoryHydration?.(
    afterSessionA,
    "sess_b",
  );
  assert.ok(afterSessionB);

  assert.notEqual(afterSessionA, afterSessionB);
  assert.equal(
    hasCompletedConversationHistoryHydration?.(afterSessionB, "sess_a"),
    true,
  );
  assert.equal(
    hasCompletedConversationHistoryHydration?.(afterSessionB, "sess_b"),
    true,
  );
  assert.equal(
    hasCompletedConversationHistoryHydration?.(afterSessionB, "sess_c"),
    false,
  );
  assert.equal(
    deriveConversationHistoryPhase({
      policy: "full_preload",
      activeSessionId: "sess_a",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration:
        hasCompletedConversationHistoryHydration?.(afterSessionB, "sess_a") ?? false,
      error: null,
    }),
    "ready",
  );
});

test("full preload hydration gate does not hide errors", () => {
  assert.equal(
    deriveConversationHistoryPhase({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: "boom",
    }),
    "ready",
  );
});

test("conversation history phase separates initial hydration from interactive rendering", () => {
  assert.equal(
    deriveConversationHistoryPhase({
      policy: "full_preload",
      activeSessionId: "",
      isConversationReady: false,
      hasOlder: false,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: null,
    }),
    "unselected",
  );
  assert.equal(
    deriveConversationHistoryPhase({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: null,
    }),
    "hydrating_history",
  );
  assert.equal(
    deriveConversationHistoryPhase({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: false,
      isLoadingOlder: false,
      hasCompletedInitialHydration: true,
      error: null,
    }),
    "ready",
  );
  assert.equal(
    deriveConversationHistoryPhase({
      policy: "tail_only",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: null,
    }),
    "ready",
  );
});
