import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import zh from "../apps/workbench-web/src/i18n/locales/zh-CN.json";

const locale = new LocaleRuntime([]);
await locale.update({ localeOverride: "en-US" });
function renderToStaticMarkup(children: React.ReactNode) {
  return renderMarkup(<IntlRuntimeProvider runtime={locale}>{children}</IntlRuntimeProvider>);
}

import { ComposerQueueTray } from "../packages/codex-composer/src/queue-tray";
import { supportsAtomicQueuedSteer, supportsUnconfirmedSteerDiscard } from "@opencraft/appserver-protocol";

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

test("Workbench passes the Host queue capability into the Composer prop", () => {
  const app = readFileSync(new URL("../apps/workbench-web/src/app.tsx", import.meta.url), "utf8");
  const composerTag = app.match(/<CodexComposer\b[\s\S]*?\/>/u)?.[0];
  assert.ok(composerTag, "Workbench should render CodexComposer");
  assert.match(composerTag, /supportsQueuedSteer=\{queueAtomicSteer\}/u);
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
  assert.doesNotMatch(markup, /codex-composer-queue-tray__heading/);
  assert.doesNotMatch(markup, />(?:Adding…|Saving…|Queued)</);
  assert.match(markup, /aria-busy="true"/);
});

test("queue interruption is the only state promoted to a tray header", () => {
  const markup = renderToStaticMarkup(
    <ComposerQueueTray
      items={[{ ...pendingItem, state: "failed", pausedReason: "Queue paused because you interrupted" }]}
      isResponseInProgress={false}
    />,
  );

  assert.match(markup, /Queue paused because you interrupted/);
  assert.match(markup, /Resume/);
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

test("queued Steer is disabled without Host atomic support while idle Send remains available", () => {
  const item = { ...pendingItem, state: "queued" as const, actionable: true };
  const running = renderToStaticMarkup(
    <ComposerQueueTray items={[item]} isResponseInProgress />,
  );
  assert.match(running, /aria-label="Steer with queued message"[^>]*disabled=""/);
  assert.match(running, /This Host cannot steer a queued message/);

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


test("Chinese queued steer exposes the immediate-insert tooltip and accessible name", async () => {
  const runtime = new LocaleRuntime([{ locale: "zh-CN", label: "中文", load: async () => zh }]);
  await runtime.update({ localeOverride: "zh-CN" });
  try {
    const markup = renderMarkup(<IntlRuntimeProvider runtime={runtime}>
      <ComposerQueueTray items={[{ ...pendingItem, state: "queued", actionable: true }]}
        isResponseInProgress atomicSteer />
    </IntlRuntimeProvider>);
    assert.match(markup, /class="is-labelled is-steer"[^>]*aria-label="立即插入"[^>]*title="立即插入"/);
  } finally { runtime.dispose(); }
});
