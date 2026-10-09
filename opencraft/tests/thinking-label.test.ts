import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { deriveAgentActivityHeaderPresentation } from "@opencraft/chat-core";
import { ThinkingLabel } from "../apps/workbench-web/src/components/thinking-label";
import { embeddedLocaleCatalogs } from "../apps/workbench-web/src/i18n/catalogs";

async function render(locale: string, summary?: string) {
  const runtime = new LocaleRuntime(embeddedLocaleCatalogs);
  await runtime.update({ localeOverride: locale });
  try {
    return {
      thinking: renderToStaticMarkup(React.createElement(IntlRuntimeProvider, {
      runtime, children: React.createElement(ThinkingLabel, { summary }),
      })),
      thought: runtime.getSnapshot().intl.formatMessage({ id: "chat.thought", defaultMessage: "Thought" }),
    };
  } finally { runtime.dispose(); }
}

test("Chinese turn and explicit reasoning placeholders use the same localized status", async () => {
  assert.equal((await render("zh-CN")).thinking, "思考中...");
  assert.equal((await render("zh-CN", "Thinking")).thinking, "思考中...");
  assert.equal((await render("zh-CN", "正在检查日志")).thinking, "正在检查日志");
  assert.equal((await render("en-US", "Thinking")).thinking, "Thinking");
});

test("embedded console locales translate running and settled reasoning labels", async () => {
  const expected = new Map<string, readonly [string, string]>([
    ["en-US", ["Thinking", "Thought"]],
    ["zh-CN", ["思考中...", "思考过程"]],
    ["zh-SG", ["思考中...", "思考过程"]],
    ["zh-Hant", ["思考中…", "思考過程"]],
    ["id-ID", ["Sedang berpikir…", "Proses berpikir"]],
    ["es", ["Pensando…", "Razonamiento"]],
    ["ja-JP", ["思考中…", "思考過程"]],
    ["ko-KR", ["생각하는 중…", "사고 과정"]],
  ]);
  for (const [locale, [thinking, thought]] of expected) {
    assert.deepEqual(await render(locale), { thinking, thought }, locale);
  }
});

test("activity waiting between tools localizes the core Thinking placeholder", async () => {
  const header = deriveAgentActivityHeaderPresentation({
    blocks: [],
    lifecycle: {
      isLatestVisibleUnit: true, inProgress: true, isActivitySliceClosed: false,
      isExploring: false,
    },
  });
  assert.equal(header.state, "thinking");
  assert.equal(header.summary.kind, "text");
  if (header.summary.kind === "text") {
    assert.equal((await render("zh-CN", header.summary.text)).thinking, "思考中...");
  }
});
