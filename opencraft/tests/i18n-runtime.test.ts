import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleRuntime, canonicalizeLocale, getLocaleTextDirection, resolveRequestedLocale, resolveBestLocale, type MessageCatalog } from "@opencraft/i18n";
import { IntlRuntimeProvider, FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("Codex source policy: explicit override, IDE, SYSTEM and non-English FIRST_AVAILABLE", () => {
  assert.equal(resolveRequestedLocale({ localeOverride: "pt_br", ideLocale: "ja-JP", systemLocale: "zh-CN" }), "pt-BR");
  assert.equal(resolveRequestedLocale({ ideLocale: "ja-JP", systemLocale: "zh-CN" }), "ja-JP");
  assert.equal(resolveRequestedLocale({ localeSource: "SYSTEM", ideLocale: "ja-JP", systemLocale: "zh-CN" }), "zh-CN");
  assert.equal(resolveRequestedLocale({ localeSource: "FIRST_AVAILABLE", ideLocale: "en-GB", systemLocale: "zh-CN" }), "zh-CN");
  assert.equal(resolveRequestedLocale({ localeSource: "FIRST_AVAILABLE", ideLocale: "ja", systemLocale: "zh-CN" }), "ja");
  assert.equal(resolveRequestedLocale({ localeSource: "FIRST_AVAILABLE", ideLocale: "en-GB", systemLocale: "en-AU" }), "en-US");
  assert.equal(resolveRequestedLocale({ localeOverride: "../../bad", ideLocale: "de" }), "de");
  assert.equal(canonicalizeLocale(" xx_@bad"), undefined);
});

test("regional best matching and text direction do not depend on product region", () => {
  const locales = ["zh-CN", "zh-HK", "zh-TW", "es-419", "es-ES", "pt-BR", "pt-PT", "ar"];
  assert.equal(resolveBestLocale("zh_hant", locales), "zh-TW");
  assert.equal(resolveBestLocale("zh-Hant-HK", locales), "zh-HK");
  assert.equal(resolveBestLocale("zh-SG", locales), "zh-CN");
  assert.equal(resolveBestLocale("es-MX", locales), "es-419");
  assert.equal(resolveBestLocale("pt", locales), "pt-BR");
  assert.equal(resolveBestLocale("fr", locales), undefined);
  assert.equal(getLocaleTextDirection("ar-EG"), "rtl");
  assert.equal(getLocaleTextDirection("he"), "rtl");
  assert.equal(getLocaleTextDirection("en-US"), "ltr");
});

test("late locale load and disposal never republish retired state", async () => {
  const zh = deferred<MessageCatalog>();
  const ja = deferred<MessageCatalog>();
  const runtime = new LocaleRuntime([
    { locale: "zh-CN", label: "中文", load: () => zh.promise },
    { locale: "ja-JP", label: "日本語", load: () => ja.promise },
  ]);
  const first = runtime.update({ localeOverride: "zh-CN" });
  const second = runtime.update({ localeOverride: "ja-JP" });
  ja.resolve({ hello: "こんにちは" }); await second;
  zh.resolve({ hello: "你好" }); await first;
  assert.equal(runtime.getSnapshot().intl.locale, "ja-JP");
  assert.equal(runtime.getSnapshot().intl.formatMessage({ id: "hello", defaultMessage: "Hello" }), "こんにちは");
  let notifications = 0;
  runtime.subscribe(() => notifications++);
  const third = runtime.update({ localeOverride: "zh-CN" });
  const beforeDispose = notifications;
  runtime.dispose(); await third;
  assert.equal(notifications, beforeDispose);
});

test("failed chunks fall back to source messages and can be retried", async () => {
  let attempts = 0;
  const errors: string[] = [];
  const runtime = new LocaleRuntime([{ locale: "zh-CN", label: "中文", load: async () => {
    if (++attempts === 1) throw new Error("sensitive upstream payload");
    return { hello: "你好" };
  } }], event => errors.push(JSON.stringify(event)));
  await runtime.update({ localeOverride: "zh-CN" });
  assert.equal(runtime.getSnapshot().phase, "error");
  assert.equal(runtime.getSnapshot().intl.formatMessage({ id: "hello", defaultMessage: "Hello" }), "Hello");
  assert.ok(errors.every(error => !error.includes("sensitive")));
  await runtime.update({ localeOverride: "zh-CN" });
  assert.equal(runtime.getSnapshot().phase, "ready");
  assert.equal(attempts, 2);
  await runtime.update({ localeOverride: "en-US" });
  await runtime.update({ localeOverride: "zh-CN" });
  assert.equal(attempts, 2, "successful bundles are cached");
  await runtime.update({ localeOverride: "zh-CN", enabled: false });
  assert.equal(runtime.getSnapshot().intl.formatMessage({ id: "hello", defaultMessage: "Hello" }), "Hello");
  runtime.dispose();
});

test("React and imperative consumers share the same Intl object, ICU and rich text", async () => {
  const runtime = new LocaleRuntime([{ locale: "zh-CN", label: "中文", load: async () => ({ hello: "你好 {name}" }) }]);
  await runtime.update({ localeOverride: "zh-CN" });
  function Consumer() {
    const intl = useIntl();
    assert.equal(intl, runtime.getSnapshot().intl);
    return React.createElement(FormattedMessage, { id: "hello", defaultMessage: "Hello {name}", values: { name: "Ada" } });
  }
  assert.equal(renderToStaticMarkup(React.createElement(IntlRuntimeProvider, { runtime, children: React.createElement(Consumer) })), "你好 Ada");
  await runtime.update({ localeOverride: "en-US" });
  const intl = runtime.getSnapshot().intl;
  assert.equal(intl.formatMessage({ id: "replies", defaultMessage: "{count, plural, one {# reply} other {# replies}}" }, { count: 2 }), "2 replies");
  assert.equal(intl.formatMessage({ id: "choice", defaultMessage: "{state, select, ready {Ready} other {Waiting}}" }, { state: "ready" }), "Ready");
  assert.equal(intl.formatNumber(1234.5), "1,234.5");
  assert.equal(intl.formatList(["A", "B"]), "A and B");
  assert.equal(intl.formatRelativeTime(-1, "day", { numeric: "auto" }), "yesterday");
  const rich = React.createElement(FormattedMessage, { id: "rich", defaultMessage: "Open <b>{name}</b>", values: { name: "settings", b: chunks => React.createElement("strong", { key: "b" }, chunks) } });
  assert.equal(renderToStaticMarkup(React.createElement(IntlRuntimeProvider, { runtime, children: rich })), "Open <strong>settings</strong>");
  runtime.dispose();
});

test("instances are isolated and missing languages retain locale formatting with English copy", async () => {
  const a = new LocaleRuntime([]), b = new LocaleRuntime([]);
  await a.update({ localeOverride: "ar-EG" });
  assert.equal(a.getSnapshot().direction, "rtl");
  assert.equal(b.getSnapshot().intl.locale, "en-US");
  assert.equal(a.getSnapshot().intl.formatMessage({ id: "unknown", defaultMessage: "Hello" }), "Hello");
  assert.equal(a.getSnapshot().intl.formatNumber(1200), new Intl.NumberFormat("ar-EG").format(1200));
  a.dispose(); b.dispose();
});

test("locale overrides persist through the existing preference authority; automatic stays inherited", async () => {
  const installation = new MemoryUiPreferenceStore();
  let runtime = await UiPreferencesRuntime.open({ installation });
  await runtime.set("locale.override", "zh-CN"); await runtime.close();
  runtime = await UiPreferencesRuntime.open({ installation });
  assert.equal(runtime.get("locale.override"), "zh-CN");
  await assert.rejects(runtime.set("locale.override", "../../../bad"));
  await runtime.reset("locale.override"); await runtime.close();
  runtime = await UiPreferencesRuntime.open({ installation });
  assert.equal(runtime.get("locale.override"), "");
  await runtime.close();
});
