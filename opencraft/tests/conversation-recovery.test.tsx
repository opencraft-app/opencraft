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
} from "../apps/workbench-web/src/components/conversation-recovery";

test("recovery presentation retains painted history across syncing and failure", () => {
  assert.equal(conversationRecoveryPresentation({ authoritative: false, hasVisibleHistory: true, failed: false }), "warm-loading");
  assert.equal(conversationRecoveryPresentation({ authoritative: false, hasVisibleHistory: true, failed: true }), "warm-error");
  assert.equal(conversationRecoveryPresentation({ authoritative: false, hasVisibleHistory: false, failed: false }), "cold-loading");
  assert.equal(conversationRecoveryPresentation({ authoritative: false, hasVisibleHistory: false, failed: true }), "cold-error");
  assert.equal(conversationRecoveryPresentation({ authoritative: true, hasVisibleHistory: true, failed: false }), "none");
});

test("only cold loading gets a passive ring; failures keep an actionable retry", () => {
  const runtime = new LocaleRuntime([]);
  const render = (child: ReactElement) => renderToStaticMarkup(createElement(IntlRuntimeProvider, { runtime, children: child }));
  const notice = render(createElement(ConversationRecoveryNotice, { failed: false, reconnecting: true }));
  const syncing = render(createElement(ConversationRecoveryNotice, { failed: false, reconnecting: false }));
  const error = render(createElement(ConversationRecoveryNotice, { failed: true, reconnecting: true, onRetry() {} }));
  const loading = render(createElement(ConversationRecoveryEmptyState, { failed: false }));
  const coldError = render(createElement(ConversationRecoveryEmptyState, { failed: true, onRetry() {} }));
  assert.match(notice, /conversation-recovery-notice/);
  assert.doesNotMatch(notice, /workbench-loading-spinner|conversation-hydration-stage/);
  assert.match(syncing, /Syncing/);
  assert.match(error, /role="alert"/);
  assert.match(error, /<button/);
  assert.match(loading, /role="status"/);
  assert.match(loading, /conversation-recovery-loading__label/);
  assert.match(loading, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(loading, /<circle[^>]*opacity="0.3"/);
  assert.doesNotMatch(loading, /<button|tabindex|skeleton__line/);
  assert.match(coldError, /role="alert"/);
  assert.match(coldError, /<button/);
  assert.doesNotMatch(coldError, /workbench-loading-spinner/);
  runtime.dispose();
});
