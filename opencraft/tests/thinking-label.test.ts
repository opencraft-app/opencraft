import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { deriveAgentActivityHeaderPresentation } from "@opencraft/chat-core";
import { ThinkingLabel } from "../apps/workbench-web/src/components/thinking-label";
import zh from "../apps/workbench-web/src/i18n/locales/zh-CN.json";

async function render(locale: string, summary?: string) {
  const runtime = new LocaleRuntime([{ locale: "zh-CN", label: "中文", load: async () => zh }]);
  await runtime.update({ localeOverride: locale });
  try {
    return renderToStaticMarkup(React.createElement(IntlRuntimeProvider, {
      runtime, children: React.createElement(ThinkingLabel, { summary }),
    }));
  } finally { runtime.dispose(); }
}

test("Chinese turn and explicit reasoning placeholders use the same localized status", async () => {
  assert.equal(await render("zh-CN"), "思考中...");
  assert.equal(await render("zh-CN", "Thinking"), "思考中...");
  assert.equal(await render("zh-CN", "正在检查日志"), "正在检查日志");
  assert.equal(await render("en-US", "Thinking"), "Thinking");
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
    assert.equal(await render("zh-CN", header.summary.text), "思考中...");
  }
});
