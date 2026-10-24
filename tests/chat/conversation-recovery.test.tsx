import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import {
  ConversationRecoveryNotice,
  ConversationRecoveryEmptyState,
  conversationRecoveryPresentation,
  conversationRecoveryIsPending,
} from "../../apps/workbench-web/src/components/conversation-recovery";

test("recovery presentation retains painted history across syncing and failure", () => {
  assert.equal(conversationRecoveryPresentation({ authoritative: false, hasVisibleHistory: true, failed: false }), "warm-loading");
  assert.equal(conversationRecoveryPresentation({ authoritative: false, hasVisibleHistory: true, failed: true }), "warm-error");
  assert.equal(conversationRecoveryPresentation({ authoritative: false, hasVisibleHistory: false, failed: false }), "cold-loading");
  assert.equal(conversationRecoveryPresentation({ authoritative: false, hasVisibleHistory: false, failed: true }), "cold-error");
  assert.equal(conversationRecoveryPresentation({ authoritative: true, hasVisibleHistory: true, failed: false }), "none");
});

test("routine recovery has no error, retry button or diagnostic UI in cold and retained history", () => {
  const runtime = new LocaleRuntime([]);
  try {
    for (const Component of [ConversationRecoveryNotice, ConversationRecoveryEmptyState]) {
      for (const failed of [false, true]) {
        assert.equal(renderToStaticMarkup(createElement(IntlRuntimeProvider, { runtime,
          children: createElement(Component, { failed }) })), "");
      }
      const markup = renderToStaticMarkup(createElement(IntlRuntimeProvider, { runtime,
        children: createElement(Component, { failed: true, requiresUpdate: true }) }));
      assert.match(markup, /Update or reload to reconnect/);
      assert.doesNotMatch(markup, /<button|<details|<pre|Try again|Technical details/);
    }
  } finally { runtime.dispose(); }
});

test("technical details distinguish history errors and never copy remote text or payloads", async () => {
  const { createConversationRecoveryDiagnostic, conversationRecoveryDiagnosticText } = await import("../../apps/workbench-web/src/runtime/conversation-recovery-diagnostic");
  const diagnostic = createConversationRecoveryDiagnostic({
    stage: "history", error: { code: -32001, message: "secret body", data: { token: "secret-token" } },
    runtime: "ready", transport: { state: "open", reason: "secret-url", failure: {
      code: "APP_HOST_DISCONNECTED", recovery: "automatic", diagnostic: {
        attemptId: "stale-other-connection", occurredAt: "2026-10-17T14:00:00.000Z", phase: "connecting", failure: "socket-error",
      },
    } },
  }, "2026-10-17T14:01:00.000Z");
  const text = conversationRecoveryDiagnosticText(diagnostic);
  assert.match(text, /stage: history\ncode: -32001\noccurredAt: 2026-10-17T14:01:00.000Z/);
  assert.doesNotMatch(text, /secret|stale|APP_HOST|recoveryPolicy|attemptId/);
  assert.equal(createConversationRecoveryDiagnostic({ stage: "activation", error: { code: "private content" }, runtime: "ready", transport: { state: "open" } }).code, "UNCLASSIFIED");
});

test('console prints the full allowlisted clipboard snapshot with physical correlation', async context => {
 const {logConversationRecoveryDiagnostic,conversationRecoveryDiagnosticText,createConversationRecoveryDiagnostic}=await import('../../apps/workbench-web/src/runtime/conversation-recovery-diagnostic');
 const values:unknown[][]=[];context.mock.method(console,'log',(...args:unknown[])=>{values.push(args);});
 const diagnostic=createConversationRecoveryDiagnostic({stage:'history',runtime:'ready',error:{code:'TIMEOUT',message:'secret-body'},transport:{state:'open',attemptId:'11111111-1111-4111-8111-111111111111',reason:'secret-url'}});
 const expected=conversationRecoveryDiagnosticText(diagnostic,1234);
 assert.equal(logConversationRecoveryDiagnostic(diagnostic,1234),expected);
 assert.deepEqual(values,[['[conversation-recovery] details\n'+expected]]);
 assert.match(expected,/attemptId: 11111111-1111-4111-8111-111111111111/);assert.doesNotMatch(expected,/secret/);
});




test("Composer recovery scan follows current recovery, including automatic retries, but stops on terminal errors", async () => {
  const { createConversationRecoveryDiagnostic } = await import("../../apps/workbench-web/src/runtime/conversation-recovery-diagnostic");
  const diagnostic = createConversationRecoveryDiagnostic({ stage: "history", error: null, runtime: "ready", transport: {state: "open"} });
  assert.equal(conversationRecoveryIsPending("none"), false);
  assert.equal(conversationRecoveryIsPending("cold-loading"), true);
  assert.equal(conversationRecoveryIsPending("warm-loading"), true);
  assert.equal(conversationRecoveryIsPending("warm-error"), false);
  for (const stage of ["connecting", "initializing", "queued", "history", "backoff", "blocked", "failed"] as const) {
    const observation = { ...diagnostic, progress: { recoveryId: "test", startedAt: 0, stage, stageStartedAt: 0, attempt: 1, events: [] } };
    assert.equal(conversationRecoveryIsPending("warm-error", observation), stage !== "blocked" && stage !== "failed");
    assert.equal(conversationRecoveryIsPending("cold-loading", observation), stage !== "blocked" && stage !== "failed");
    assert.equal(conversationRecoveryIsPending("warm-error", observation, true), false);
  }
});


test('console prints the full allowlisted clipboard snapshot with physical correlation', async context => {
 const {logConversationRecoveryDiagnostic,conversationRecoveryDiagnosticText,createConversationRecoveryDiagnostic}=await import('../../apps/workbench-web/src/runtime/conversation-recovery-diagnostic');
 const values:unknown[][]=[];context.mock.method(console,'log',(...args:unknown[])=>{values.push(args);});
 const diagnostic=createConversationRecoveryDiagnostic({stage:'history',runtime:'ready',error:{code:'TIMEOUT',message:'secret-body'},transport:{state:'open',attemptId:'11111111-1111-4111-8111-111111111111',reason:'secret-url'}});
 const expected=conversationRecoveryDiagnosticText(diagnostic,1234);
 assert.equal(logConversationRecoveryDiagnostic(diagnostic,1234),expected);
 assert.deepEqual(values,[['[conversation-recovery] details\n'+expected]]);
 assert.match(expected,/attemptId: 11111111-1111-4111-8111-111111111111/);assert.doesNotMatch(expected,/secret/);
});
