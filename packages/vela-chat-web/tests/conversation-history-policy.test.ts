import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DESKTOP_CONVERSATION_HISTORY_POLICY,
  shouldShowConversationHistoryHydrationGate,
  shouldAutoPreloadOlderConversation,
} from "../../../app/chat/workbench/conversation-history/policy";

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
    shouldShowConversationHistoryHydrationGate({
      policy: DEFAULT_DESKTOP_CONVERSATION_HISTORY_POLICY,
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: null,
    }),
    true,
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

test("full preload uses a page hydration gate only during initial conversation hydration", () => {
  assert.equal(
    shouldShowConversationHistoryHydrationGate({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: null,
    }),
    true,
  );
  assert.equal(
    shouldShowConversationHistoryHydrationGate({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: false,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: null,
    }),
    false,
  );
  assert.equal(
    shouldShowConversationHistoryHydrationGate({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: false,
      hasOlder: true,
      isLoadingOlder: true,
      hasCompletedInitialHydration: true,
      error: null,
    }),
    false,
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

test("full preload hydration gate does not hide errors", () => {
  assert.equal(
    shouldShowConversationHistoryHydrationGate({
      policy: "full_preload",
      activeSessionId: "sess_1",
      isConversationReady: true,
      hasOlder: true,
      isLoadingOlder: false,
      hasCompletedInitialHydration: false,
      error: "boom",
    }),
    false,
  );
});
