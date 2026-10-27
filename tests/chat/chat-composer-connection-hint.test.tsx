import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { createConversationKey } from "@opencraft/chat-core";
import { createComposerController } from "@opencraft/composer-core";
// This Node suite renders markup; browser styles are exercised by smoke tests.
const styles = registerHooks({
  load(url, context, nextLoad) {
    return /\.(?:css|scss)$/u.test(new URL(url).pathname)
      ? { format: "module", source: "export default {};", shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { OpenCraftComposer, groupComposerModels } = await import("@opencraft/composer-editor");
styles.deregister();
import { embeddedLocaleCatalogs } from "../../apps/workbench-web/src/i18n/catalogs";

// tsx compiles package sources with the classic JSX runtime.
(globalThis as { React?: typeof React }).React = React;

const selectionCatalog = { agents: [], permissionProfiles: [], models: [{ id: "m", value: "m", label: "M", isDefault: true,
  description: null, efforts: [], defaultEffort: null, inputModalities: ["text"] }] } as const;

async function render(options: { text: string; submissionDisabled: boolean; locale?: string; modelSelectionPolicy?: "session" | "host-default"; noModels?: boolean; modelError?: string; isFetching?: boolean; withReasoning?: boolean }) {
  const locale = new LocaleRuntime(embeddedLocaleCatalogs);
  await locale.update({ localeOverride: options.locale ?? "zh-CN" });
  let id = 0;
  const controller = createComposerController({ type: "existing-thread", key: createConversationKey("test", "hint") },
    { now: Date.now, createId: () => String(++id) });
  if (options.text) controller.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: options.text }] }] } as never });
  return renderToStaticMarkup(<IntlRuntimeProvider runtime={locale}>
    <OpenCraftComposer controller={controller} submissionDisabled={options.submissionDisabled}
      onSubmit={() => false} onCancel={() => {}} selectionCatalog={{ ...selectionCatalog,
        models: options.noModels ? [] : options.withReasoning
          ? selectionCatalog.models.map(model => ({ ...model, efforts: [{ value: "medium", label: "Medium", description: null }], defaultEffort: "medium" }))
          : selectionCatalog.models,
        modelError: options.modelError,
        isFetching: options.isFetching,
      } as never}
      effectiveSelections={options.noModels ? undefined : { model: "m" }}
      modelSelectionPolicy={options.modelSelectionPolicy} />
  </IntlRuntimeProvider>);
}

const hint = /class="opencraft-composer-connection-hint" role="status">正在连接，连上后即可发送</u;

test("typed content waiting for the Host explains why it cannot be sent", async () => {
  assert.match(await render({ text: "帮我写周报", submissionDisabled: true }), hint);
});

test("the hint stays quiet for an empty Composer or a connected Host", async () => {
  assert.doesNotMatch(await render({ text: "", submissionDisabled: true }), /opencraft-composer-connection-hint/u);
  assert.doesNotMatch(await render({ text: "帮我写周报", submissionDisabled: false }), /opencraft-composer-connection-hint/u);
});

test("every embedded console language translates the hint", async () => {
  for (const catalog of embeddedLocaleCatalogs) {
    if (catalog.locale === "en-US") continue;
    const messages = await catalog.load();
    assert.ok(typeof messages["chat.waitingForHostToSend"] === "string" && messages["chat.waitingForHostToSend"].length > 0, catalog.locale);
  }
});

test("embedded session policy shows the configured model picker", async () => {
  const html = await render({ text: "", submissionDisabled: false, modelSelectionPolicy: "session" });
  assert.match(html, /opencraft-composer-mode--intelligence/u);
  assert.match(html, /class="opencraft-composer-mode__model-label">M</u);
  assert.doesNotMatch(html, /opencraft-composer-mode__model-skeleton/u);
  assert.doesNotMatch(html, /title="M"/u);
  assert.doesNotMatch(await render({ text: "", submissionDisabled: false, modelSelectionPolicy: "host-default" }), /opencraft-composer-mode--intelligence/u);
});

test("embedded model label stays visible while a cached catalog refreshes", async () => {
  const html = await render({ text: "", submissionDisabled: false, modelSelectionPolicy: "session", isFetching: true });
  assert.match(html, /class="opencraft-composer-mode__model-label">M</u);
  assert.doesNotMatch(html, /opencraft-composer-mode__model-skeleton/u);
});

test("embedded model groups keep provider models and built-in auto under their headings", () => {
  const models = [
    { ...selectionCatalog.models[0]!, id: "auto", label: "自动", groupKey: "built-in", groupLabel: "内置模型" },
    { ...selectionCatalog.models[0]!, id: "plan-a", label: "模型 A", groupKey: "plan", groupLabel: "腾讯云 Token Plan" },
    { ...selectionCatalog.models[0]!, id: "other", label: "Other", groupKey: "other", groupLabel: "其他套餐" },
    { ...selectionCatalog.models[0]!, id: "plan-b", label: "模型 B", groupKey: "plan", groupLabel: "腾讯云 Token Plan" },
  ];
  assert.deepEqual(groupComposerModels(models, true).map((group) =>
    [group.label, group.models.map((model) => model.label)]), [
    ["内置模型", ["自动"]], ["腾讯云 Token Plan", ["模型 A", "模型 B"]], ["其他套餐", ["Other"]],
  ]);
  assert.equal(groupComposerModels(models, false).length, models.length);
});

test("embedded model picker does not present catalog-derived reasoning", async () => {
  const html = await render({ text: "", submissionDisabled: false, modelSelectionPolicy: "session", withReasoning: true });
  assert.match(html, /aria-label="M"/u);
  assert.doesNotMatch(html, /opencraft-composer-mode__effort-label|思考强度: Medium/u);
});

test("an empty or failed embedded catalog leaves the picker available for status and retry", async () => {
  const empty = await render({ text: "", submissionDisabled: false, modelSelectionPolicy: "session", noModels: true });
  assert.match(empty, /class="opencraft-composer-mode opencraft-composer-mode--intelligence"/u);
  assert.doesNotMatch(empty, /class="opencraft-composer-mode opencraft-composer-mode--intelligence"[^>]*disabled/u);
  assert.match(empty, /aria-label="模型"/u);
  assert.match(empty, /opencraft-composer-mode__model-skeleton/u);
  assert.doesNotMatch(empty, /class="opencraft-composer-mode__model-label">模型</u);
  const failed = await render({ text: "", submissionDisabled: false, modelSelectionPolicy: "session", noModels: true, modelError: "internal failure" });
  assert.match(failed, /title="无法加载模型，请重试。"/u);
  assert.doesNotMatch(failed, /internal failure/u);
});
