import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConversationScrollWrite,
  deriveConversationScrollWriteDecision,
  type ConversationScrollWrite,
  type ConversationScrollWritePhase,
} from "../src/conversation-runtime/scroll/scrollWrite";

function write(source: ConversationScrollWrite["source"]): ConversationScrollWrite {
  return {
    source,
    reason: "test",
    scrollTop: 420,
  };
}

test("scroll write arbitration blocks passive writes while route resume is pending", () => {
  const phase: ConversationScrollWritePhase = {
    routeResumeStatus: "pending",
  };

  assert.deepEqual(
    deriveConversationScrollWriteDecision({
      phase,
      write: write("bottom_follow"),
    }),
    {
      action: "suppress",
      blockedBy: "route_resume_pending",
      write: write("bottom_follow"),
    },
  );
  assert.deepEqual(
    deriveConversationScrollWriteDecision({
      phase,
      write: write("virtualizer_measurement"),
    }),
    {
      action: "suppress",
      blockedBy: "route_resume_pending",
      write: write("virtualizer_measurement"),
    },
  );
});

test("scroll write arbitration allows explicit user-directed writes during route resume", () => {
  const phase: ConversationScrollWritePhase = {
    routeResumeStatus: "pending",
  };

  assert.deepEqual(
    deriveConversationScrollWriteDecision({
      phase,
      write: write("scrollbar_overlay"),
    }),
    {
      action: "apply",
      blockedBy: null,
      write: write("scrollbar_overlay"),
    },
  );
  assert.deepEqual(
    deriveConversationScrollWriteDecision({
      phase,
      write: write("user_scroll"),
    }),
    {
      action: "apply",
      blockedBy: null,
      write: write("user_scroll"),
    },
  );
});

test("scroll write arbitration applies passive writes when route resume is idle", () => {
  assert.deepEqual(
    deriveConversationScrollWriteDecision({
      phase: { routeResumeStatus: "idle" },
      write: write("bottom_follow"),
    }),
    {
      action: "apply",
      blockedBy: null,
      write: write("bottom_follow"),
    },
  );
});

test("scroll write helper suppresses blocked DOM writes without moving the element", () => {
  const element = createScrollableElement(120);

  const result = applyConversationScrollWrite({
    element,
    phase: { routeResumeStatus: "pending" },
    write: write("bottom_follow"),
  });

  assert.equal(element.scrollTop, 120);
  assert.equal(result.applied, false);
  assert.equal(result.previousScrollTop, 120);
  assert.equal(result.nextScrollTop, 120);
  assert.equal(result.decision.blockedBy, "route_resume_pending");
});

test("scroll write helper applies DOM writes with instant scroll behavior", () => {
  const element = createScrollableElement(120);

  const result = applyConversationScrollWrite({
    element,
    phase: { routeResumeStatus: "pending" },
    write: write("route_resume_confirmation"),
  });

  assert.equal(element.scrollTop, 420);
  assert.equal(element.style.scrollBehavior, "smooth");
  assert.equal(result.applied, true);
  assert.equal(result.previousScrollTop, 120);
  assert.equal(result.nextScrollTop, 420);
  assert.equal(result.decision.blockedBy, null);
});

function createScrollableElement(scrollTop: number) {
  return {
    scrollTop,
    style: {
      scrollBehavior: "smooth",
    },
  };
}
