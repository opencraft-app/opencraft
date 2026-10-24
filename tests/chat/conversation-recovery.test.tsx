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

test("cold loading delegates to the Composer; retained history has no notice until manual recovery is needed", () => {
  const runtime = new LocaleRuntime([]);
  const render = (child: ReactElement) => renderToStaticMarkup(createElement(IntlRuntimeProvider, { runtime, children: child }));
  const notice = render(createElement(ConversationRecoveryNotice, { failed: false, reconnecting: true }));
  const syncing = render(createElement(ConversationRecoveryNotice, { failed: false, reconnecting: false }));
  const error = render(createElement(ConversationRecoveryNotice, { failed: true, reconnecting: true, onRetry() {} }));
  const loading = render(createElement(ConversationRecoveryEmptyState, { failed: false }));
  const coldError = render(createElement(ConversationRecoveryEmptyState, { failed: true, onRetry() {} }));
  assert.equal(notice, "");
  assert.equal(syncing, "");
  assert.match(error, /role="alert"/);
  assert.match(error, /<button/);
  assert.equal(loading, "");
  assert.match(coldError, /role="alert"/);
  assert.match(coldError, /<button/);
  assert.doesNotMatch(coldError, /workbench-loading-spinner/);
  runtime.dispose();
});

test("incompatible clients get an update instruction in both cold and retained-history recovery", () => {
  const runtime = new LocaleRuntime([]);
  const render = (child: ReactElement) => renderToStaticMarkup(createElement(IntlRuntimeProvider, { runtime, children: child }));
  try {
    for (const child of [
      createElement(ConversationRecoveryEmptyState, { failed: true, requiresUpdate: true, onRetry() {} }),
      createElement(ConversationRecoveryNotice, { failed: true, reconnecting: true, requiresUpdate: true, onRetry() {} }),
    ]) {
      const markup = render(child);
      assert.match(markup, /role="alert"/);
      assert.match(markup, /Update or reload to reconnect/);
      assert.doesNotMatch(markup, /Reconnecting|Try again|<button|workbench-loading-spinner/);
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
  const runtime = new LocaleRuntime([]);
  try {
    for (const component of [
      createElement(ConversationRecoveryEmptyState, { failed: true, diagnostic }),
      createElement(ConversationRecoveryNotice, { failed: true, reconnecting: false, diagnostic }),
    ]) {
      const markup = renderToStaticMarkup(createElement(IntlRuntimeProvider, { runtime, children: component }));
      assert.match(markup, /<details[^>]*><summary[^>]*>Technical details/);
      assert.match(markup, /History restore failed/);
      assert.match(markup, /Copy details/);
      assert.doesNotMatch(markup, /<details[^>]*open|secret|stale/);
    }
  } finally { runtime.dispose(); }
});

test("loading hides technical observations while failures retain diagnostic details", async () => {
 const {createConversationRecoveryDiagnostic,conversationRecoveryDiagnosticText}=await import("../../apps/workbench-web/src/runtime/conversation-recovery-diagnostic");
 const diagnostic={...createConversationRecoveryDiagnostic({stage:"history",error:null,runtime:"ready",transport:{state:"open"}}),code:"PENDING",progress:{
  recoveryId:"local-episode",startedAt:1000,stage:"backoff" as const,stageStartedAt:2000,attempt:2,retryAt:5000,
  lastFailure:{code:"TIMEOUT",occurredAt:2000},events:[{stage:"history" as const,at:1000,attempt:1}],
 }};
 const text=conversationRecoveryDiagnosticText(diagnostic,3000);
 assert.match(text,/recoveryId: local-episode/);assert.match(text,/elapsedMs: 2000/);assert.match(text,/stageElapsedMs: 1000/);
 assert.match(text,/lastFailureCode: TIMEOUT/);assert.match(text,/attemptsStarted: 2/);
 const runtime=new LocaleRuntime([]);
 try {
  for(const child of [
   createElement(ConversationRecoveryNotice,{failed:false,reconnecting:true,diagnostic}),
   createElement(ConversationRecoveryNotice,{failed:false,reconnecting:false,diagnostic}),
   createElement(ConversationRecoveryEmptyState,{failed:false,diagnostic}),
   createElement(ConversationRecoveryNotice,{failed:true,reconnecting:false,diagnostic}),
   createElement(ConversationRecoveryEmptyState,{failed:true,diagnostic}),
  ]){
   const html=renderToStaticMarkup(createElement(IntlRuntimeProvider,{runtime,children:child}));
   if (child.type === ConversationRecoveryNotice) assert.equal(html, "", "automatic retry remains silent even after an intermediate failure");
   else if (child.props.failed) assert.match(html,/role="alert"/);
   else assert.equal(html, "");
   assert.doesNotMatch(html,/Technical details|Copy details|Attempts started|elapsed|Retry in|TIMEOUT|local-episode|<details|<pre/);
  }
  for (const stage of ["failed", "blocked"] as const) {
  const terminalDiagnostic={...diagnostic,progress:{...diagnostic.progress,stage}};
  for(const child of [
   createElement(ConversationRecoveryNotice,{failed:true,reconnecting:false,diagnostic:terminalDiagnostic,onRetry(){}}),
   createElement(ConversationRecoveryEmptyState,{failed:true,diagnostic:terminalDiagnostic,onRetry(){}}),
  ]){
   const html=renderToStaticMarkup(createElement(IntlRuntimeProvider,{runtime,children:child}));
   assert.match(html,/Try again/);
   assert.match(html,/Technical details/);assert.match(html,/Copy details/);
   assert.doesNotMatch(html,/<details[^>]*open/);
   assert.doesNotMatch(html,/conversation-recovery-progress|Attempts started:|Retry in |\d+s elapsed/, "stopped recovery keeps observations inside the collapsed report");
  }
  }
 }finally{runtime.dispose();}
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
