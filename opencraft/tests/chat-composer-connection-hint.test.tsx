import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { createConversationKey } from "@opencraft/chat-core";
import { createComposerController } from "@opencraft/composer-core";
import { CodexComposer } from "@opencraft/codex-composer";
import { embeddedLocaleCatalogs } from "../apps/workbench-web/src/i18n/catalogs";

// tsx compiles package sources with the classic JSX runtime.
(globalThis as { React?: typeof React }).React = React;

const selectionCatalog = { agents: [], permissionProfiles: [], models: [{ id: "m", value: "m", label: "M", isDefault: true,
  description: null, efforts: [], defaultEffort: null, inputModalities: ["text"] }] } as const;

async function render(options: { text: string; submissionDisabled: boolean; locale?: string }) {
  const locale = new LocaleRuntime(embeddedLocaleCatalogs);
  await locale.update({ localeOverride: options.locale ?? "zh-CN" });
  let id = 0;
  const controller = createComposerController({ type: "existing-thread", key: createConversationKey("test", "hint") },
    { now: Date.now, createId: () => String(++id) });
  if (options.text) controller.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: options.text }] }] } as never });
  return renderToStaticMarkup(<IntlRuntimeProvider runtime={locale}>
    <CodexComposer controller={controller} submissionDisabled={options.submissionDisabled}
      onSubmit={() => false} onCancel={() => {}} selectionCatalog={selectionCatalog as never} />
  </IntlRuntimeProvider>);
}

const hint = /class="codex-composer-connection-hint" role="status">正在连接，连上后即可发送</u;

test("typed content waiting for the Host explains why it cannot be sent", async () => {
  assert.match(await render({ text: "帮我写周报", submissionDisabled: true }), hint);
});

test("the hint stays quiet for an empty Composer or a connected Host", async () => {
  assert.doesNotMatch(await render({ text: "", submissionDisabled: true }), /codex-composer-connection-hint/u);
  assert.doesNotMatch(await render({ text: "帮我写周报", submissionDisabled: false }), /codex-composer-connection-hint/u);
});

test("every embedded console language translates the hint", async () => {
  for (const catalog of embeddedLocaleCatalogs) {
    if (catalog.locale === "en-US") continue;
    const messages = await catalog.load();
    assert.ok(typeof messages["chat.waitingForHostToSend"] === "string" && messages["chat.waitingForHostToSend"].length > 0, catalog.locale);
  }
});
