import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

import React from "react";
import { renderToStaticMarkup as renderMarkup, renderToReadableStream } from "react-dom/server";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import zh from "../../apps/workbench-web/src/i18n/locales/zh-CN.json";

const locale = new LocaleRuntime([]);
await locale.update({ localeOverride: "en-US" });
function renderToStaticMarkup(children: React.ReactNode) {
  return renderMarkup(<IntlRuntimeProvider runtime={locale}>{children}</IntlRuntimeProvider>);
}

import { ComposerQueueTray } from "../../packages/composer-editor/src/queue-tray";
// This Node suite renders markup; browser styles are exercised by smoke tests.
const styles = registerHooks({
  load(url, context, nextLoad) {
    return /\.(?:css|scss)$/u.test(new URL(url).pathname)
      ? { format: "module", source: "export default {};", shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { OpenCraftComposer } = await import("@opencraft/composer-editor");
styles.deregister();
import { createConversationKey } from "@opencraft/chat-core";
import { createComposerController } from "@opencraft/composer-core";
import { queuedSubmissionPresentation } from "../../apps/workbench-web/src/queued-submission-presentation";
import { supportsAtomicQueuedSteer, supportsUnconfirmedSteerDiscard } from "@opencraft/appserver-protocol";

// tsx compiles package sources with the classic JSX runtime.
(globalThis as { React?: typeof React }).React = React;

const pendingItem = {
  id: "client-command-1",
  preview: "Inspect the failed deployment",
  state: "submitting" as const,
  operation: "idle" as const,
  actionable: false,
  editing: false,
};

test("only a declared V2 atomic queue capability enables queued Steer", () => {
  assert.equal(supportsAtomicQueuedSteer(undefined), false);
  assert.equal(supportsAtomicQueuedSteer({ version: 2, reorder: true }), false);
  assert.equal(supportsAtomicQueuedSteer({ version: 1, atomicSteer: true }), false);
  assert.equal(supportsAtomicQueuedSteer({ version: 2, atomicSteer: true }), true);
  assert.equal(supportsUnconfirmedSteerDiscard({ version: 2, atomicSteer: true }), false);
  assert.equal(supportsUnconfirmedSteerDiscard({ version: 2, atomicSteer: true, unconfirmedSteerDiscard: true }), true);
});

test("normal queued follow-ups render as messages rather than transport UI", () => {
  const markup = renderToStaticMarkup(
    <ComposerQueueTray
      items={[pendingItem]}
      pausedReason={null}
      isResponseInProgress
    />,
  );

  assert.match(markup, /Inspect the failed deployment/);
  assert.match(markup, /data-queue-size="1"/);
  assert.doesNotMatch(markup, /opencraft-composer-queue-tray__heading/);
  assert.doesNotMatch(markup, />(?:Adding…|Saving…|Queued)</);
  assert.match(markup, /aria-busy="true"/);
});

test("failed local queue entries can be deleted while unaccepted entries stay disabled", () => {
  const failed = renderToStaticMarkup(
    <ComposerQueueTray items={[{ ...pendingItem, state: "failed", dismissible: true }]} isResponseInProgress />,
  );
  assert.match(failed, /aria-label="Delete queued message"/);
  assert.doesNotMatch(failed, /aria-label="Delete queued message"[^>]*disabled=""/);

  const submitting = renderToStaticMarkup(
    <ComposerQueueTray items={[pendingItem]} isResponseInProgress />,
  );
  assert.match(submitting, /aria-label="Delete queued message"[^>]*disabled=""/);
});

test("Workbench queue projection keeps uncertain delivery non-deletable through the Composer", async () => {
  const submission = {
    commandId: "local-follow-up",
    clientMessageId: "client-follow-up",
    serverSubmissionId: null,
    input: [],
    preview: "Next",
    operation: "idle" as const,
    createdAt: 100,
    pausedReason: null,
    error: null,
  };
  const controller = createComposerController(
    { type: "existing-thread", key: createConversationKey("local", "thread-one") },
    { now: () => 100, createId: () => "composer-id" },
  );
  const renderState = async (state: "submitting" | "failed" | "unknown") => {
    const stream = await renderToReadableStream(<IntlRuntimeProvider runtime={locale}>
    <OpenCraftComposer
      controller={controller}
      isStreaming
      queuedSubmissions={[queuedSubmissionPresentation({ ...submission, state }, true)]}
      onSubmit={() => false}
      onCancel={() => {}}
    /></IntlRuntimeProvider>);
    await stream.allReady;
    return new Response(stream).text();
  };
  assert.match(await renderState("failed"), /aria-label="Delete queued message"(?![^>]*disabled="")/u);
  assert.match(await renderState("submitting"), /aria-label="Delete queued message"[^>]*disabled=""/u);
  const unknown = await renderState("unknown");
  assert.match(unknown, /data-state="unknown"/u);
  assert.match(unknown, /aria-label="Delete queued message"[^>]*disabled=""/u);
});

test("queue interruption is the only state promoted to a tray header", () => {
  const markup = renderToStaticMarkup(
    <ComposerQueueTray
      items={[{ ...pendingItem, state: "failed", actionable: true, pausedReason: "Queue paused because you interrupted" }]}
      isResponseInProgress={false}
    />,
  );

  assert.match(markup, /Queue paused because you interrupted/);
  assert.match(markup, /Resume/);
});

test("a paused row without action authority cannot resume the queue", () => {
  const markup = renderToStaticMarkup(
    <ComposerQueueTray
      items={[{ ...pendingItem, state: "failed", pausedReason: "Queue paused because you interrupted" }]}
      isResponseInProgress={false}
    />,
  );
  assert.match(markup, /Queue paused because you interrupted/);
  assert.doesNotMatch(markup, /Resume/);
});

test("unconfirmed steering claim offers review and explicit discard, never Send or Resume", () => {
  const markup = renderToStaticMarkup(
    <ComposerQueueTray items={[{
      ...pendingItem,
      state: "queued",
      pausedReason: "Delivery unconfirmed",
      unconfirmedTargetTurnId: "turn-one",
    }]} isResponseInProgress={false} />,
  );
  assert.match(markup, /Review &amp; discard/);
  assert.doesNotMatch(markup, /Start queued message|Resume|Edit queued message|Delete queued message/);
});

test("a queued item behind an unconfirmed delivery does not offer a Resume that cannot clear the claim", () => {
  const markup = renderToStaticMarkup(
    <ComposerQueueTray items={[
      { ...pendingItem, state: "queued", actionable: true, pausedReason: "Earlier delivery is unconfirmed; review it before sending another message" },
      { ...pendingItem, id: "claim-1", state: "queued", pausedReason: "Delivery unconfirmed", unconfirmedTargetTurnId: "turn-one" },
    ]} isResponseInProgress atomicSteer />,
  );
  assert.match(markup, /Earlier delivery is unconfirmed/);
  assert.match(markup, /Review &amp; discard/);
  assert.doesNotMatch(markup, /Resume/);
  assert.match(markup, /aria-label="Steer with queued message"[^>]*disabled=""/);
  assert.match(markup, /aria-label="Reorder queued message"[^>]*disabled=""/);
});

test("queued Steer is disabled without Host atomic support while idle Send remains available", () => {
  const item = { ...pendingItem, state: "queued" as const, actionable: true };
  const running = renderToStaticMarkup(
    <ComposerQueueTray items={[item]} isResponseInProgress />,
  );
  assert.match(running, /aria-label="Steer with queued message"[^>]*disabled=""/);
  assert.match(running, /This Host cannot steer a queued message/);
  assert.match(running, /class="opencraft-composer-queue-action-trigger"[^>]*tabindex="0"[^>]*role="group"[^>]*aria-disabled="true"/);

  const supported = renderToStaticMarkup(
    <ComposerQueueTray items={[item]} isResponseInProgress atomicSteer />,
  );
  assert.doesNotMatch(supported, /aria-label="Steer with queued message"[^>]*disabled=""/);

  const unreconciled = renderToStaticMarkup(
    <ComposerQueueTray items={[{ ...item, pausedReason: "restored-after-host-restart" }]} isResponseInProgress atomicSteer />,
  );
  assert.match(unreconciled, /aria-label="Steer with queued message"[^>]*disabled=""/);
  assert.match(unreconciled, /awaiting native reconciliation/);

  const idle = renderToStaticMarkup(
    <ComposerQueueTray items={[item]} isResponseInProgress={false} />,
  );
  assert.doesNotMatch(idle, /aria-label="Start queued message"[^>]*disabled=""/);
  const idleUnreconciled = renderToStaticMarkup(
    <ComposerQueueTray items={[{ ...item, pausedReason: "restored-after-host-restart" }]} isResponseInProgress={false} atomicSteer />,
  );
  assert.match(idleUnreconciled, /aria-label="Start queued message"[^>]*disabled=""/);
});


test("Chinese queued steer keeps its accessible name without a native tooltip", async () => {
  const runtime = new LocaleRuntime([{ locale: "zh-CN", label: "中文", load: async () => zh }]);
  await runtime.update({ localeOverride: "zh-CN" });
  try {
    const markup = renderMarkup(<IntlRuntimeProvider runtime={runtime}>
      <ComposerQueueTray items={[{ ...pendingItem, state: "queued", actionable: true }]}
        isResponseInProgress atomicSteer />
    </IntlRuntimeProvider>);
    assert.match(markup, /class="is-labelled is-steer"[^>]*aria-label="立即插入"/);
    assert.doesNotMatch(markup, /\btitle=/);
  } finally { runtime.dispose(); }
});

test("queued actions keep labels and use custom tooltip triggers", async () => {
  const runtime = new LocaleRuntime([{ locale: "zh-CN", label: "中文", load: async () => zh }]);
  await runtime.update({ localeOverride: "zh-CN" });
  try {
    const item = { ...pendingItem, preview: "几点了", state: "queued" as const, actionable: true };
    const markup = renderMarkup(<IntlRuntimeProvider runtime={runtime}>
      <ComposerQueueTray items={[item]} isResponseInProgress atomicSteer />
    </IntlRuntimeProvider>);
    assert.match(markup, /class="opencraft-composer-queue-item__preview"[^>]*>几点了/);
    assert.match(markup, /aria-label="调整排队消息顺序"/);
    assert.match(markup, /aria-label="编辑排队消息"/);
    assert.match(markup, /aria-label="删除排队消息"/);
    assert.doesNotMatch(markup, /\btitle=/);
    const editing = renderMarkup(<IntlRuntimeProvider runtime={runtime}>
      <ComposerQueueTray items={[{ ...item, editing: true }]} isResponseInProgress atomicSteer />
    </IntlRuntimeProvider>);
    assert.match(editing, /aria-label="取消编辑排队消息"/);
    assert.doesNotMatch(editing, /\btitle=/);
  } finally { runtime.dispose(); }
});

test("queue author photos replace the decorative leading arrow and survive projection without directory policy in Composer", () => {
  const source = {commandId: "one", clientMessageId: "message-one", serverSubmissionId: "queue-one", input: [], preview: "From Alice", state: "queued" as const, operation: "idle" as const, createdAt: 100, pausedReason: null, error: null, sender: {kind: "employee" as const, loginName: "alice"}};
  const calls: string[] = [];
  const item = queuedSubmissionPresentation(source, true, {id: "test", resolve: (kind, name) => { calls.push(`${kind}:${name}`); return "https://images.example/alice.png"; }});
  assert.deepEqual(item.sender, {name: "alice", avatarUrl: "https://images.example/alice.png"});
  const markup = renderToStaticMarkup(<ComposerQueueTray items={[{...item, editing: false}]} isResponseInProgress atomicSteer />);
  assert.match(markup, /class="opencraft-composer-queue-item__avatar" role="img" aria-label="alice"/);
  assert.match(markup, /src="https:\/\/images.example\/alice.png"/);
  assert.doesNotMatch(markup, /opencraft-composer-queue-item__message-icon/);
  assert.match(markup, /aria-label="Reorder queued message"/);
  assert.match(markup, /aria-label="Steer with queued message"/);
  assert.deepEqual(calls, ["employee:alice"]);
  assert.equal(queuedSubmissionPresentation({...source, sender: null}, true).sender, null);
  assert.equal(queuedSubmissionPresentation({...source, sender: undefined}, true).sender, null);
  assert.deepEqual(queuedSubmissionPresentation(source, true).sender, {name: "alice", avatarUrl: null}, "unloaded resolver retains an honest named fallback");
});

test("pending queue accepts Steer independently of edit and delete custody", () => {
  const render = (operation: "idle" | "starting") => renderToStaticMarkup(
    <ComposerQueueTray items={[{ ...pendingItem, steerable: true, operation }]}
      isResponseInProgress atomicSteer onSteer={async () => {}} />,
  );
  const ready = render("idle");
  assert.match(ready, /aria-label="Steer with queued message"(?![^>]*disabled="")/u);
  assert.match(ready, /aria-label="Delete queued message"[^>]*disabled=""/u);
  assert.match(render("starting"), /aria-label="Steer with queued message"[^>]*disabled=""/u);
});

test('Host queue permissions distinguish cancellation from editing and preserve older Hosts', () => {
  const submission = {
    commandId: 'managed', clientMessageId: 'actor-input:request', serverSubmissionId: 'managed',
    input: [], preview: 'External message', state: 'queued' as const, operation: 'idle' as const,
    createdAt: 1, pausedReason: null, error: null,
    actions: { edit: false, delete: true, start: false, reorder: false }, steerable: false,
  };
  const item = queuedSubmissionPresentation(submission, true);
  assert.equal(item.actionable, false);
  assert.equal(item.deletable, true);
  assert.equal(item.reorderable, false);
  assert.equal(item.steerable, false);
  const markup = renderToStaticMarkup(<ComposerQueueTray items={[{ ...item, editing: false }]} isResponseInProgress={false} />);
  const buttons = [...markup.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
  assert.ok(buttons.some(button => button.includes('Delete queued message') && !button.includes('disabled')));
  assert.ok(buttons.some(button => button.includes('Edit queued message') && button.includes('disabled')));
  const denied = queuedSubmissionPresentation({ ...submission, actions: { ...submission.actions, delete: false } }, true);
  const deniedMarkup = renderToStaticMarkup(<ComposerQueueTray items={[{ ...denied, editing: false }]} isResponseInProgress={false} />);
  assert.match(deniedMarkup, /<button[^>]*aria-label="Delete queued message"[^>]*disabled/);
  const { actions: _actions, ...legacy } = submission;
  assert.equal(queuedSubmissionPresentation(legacy, true).actionable, true);
  assert.equal(queuedSubmissionPresentation(legacy, true).deletable, true);
});


test("queue labels project Markdown to visible single-line text", () => {
  const markdown = "1. **邀请群成员**\n2. 查看 [文档](https://example.com/private-path) 和 `a_b`\n\n| 名称 | 状态 |\n| --- | --- |\n| 服务 | 正常 |";
  const markup = renderToStaticMarkup(<ComposerQueueTray items={[{ ...pendingItem, preview: markdown }]} isResponseInProgress />);
  const label = markup.match(/class="opencraft-composer-queue-item__preview">([^<]*)<\/span>/)?.[1];
  assert.equal(label, "邀请群成员 查看 文档 和 a_b 名称 状态 服务 正常");
  assert.doesNotMatch(markup, /private-path|\*\*|\| ---/);
});
