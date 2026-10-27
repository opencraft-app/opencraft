import assert from "node:assert/strict";
import test from "node:test";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { WorkbenchLocaleController } from "../../apps/workbench-web/src/i18n/workbench-locale";
import { createDesktopLocaleRuntime, requireDesktopLocale } from "../../apps/workbench-electron/src/desktop-locale";
import { withProductCatalogs } from "../../apps/workbench-web/src/i18n/product-catalogs";

test("product catalogs add messages without changing core language authority", async () => {
  const original = { core: "核心" };
  const base = [{ locale: "zh-CN", label: "中文", load: async () => original }];
  const product = { locale: "zh-CN", label: "Product", load: async () => ({ "fixture.feature": "扩展" }) };
  const catalogs = withProductCatalogs(base, [product, { ...product, locale: "fr-FR" }]);
  assert.deepEqual(catalogs.map(catalog => [catalog.locale, catalog.label]), [["zh-CN", "中文"]]);
  assert.deepEqual(await catalogs[0]!.load(), { core: "核心", "fixture.feature": "扩展" });
  assert.deepEqual(original, { core: "核心" });
  const conflict = withProductCatalogs(base, [{ ...product, load: async () => ({ core: "覆盖" }) }]);
  await assert.rejects(conflict[0]!.load(), /conflicts/);
});

test("native consumers share FormatJS semantics and reject malformed IPC locale values", async () => {
  for (const value of [null, {}, "../bad", 5]) assert.throws(() => requireDesktopLocale(value));
  assert.equal(requireDesktopLocale("zh_cn"), "zh-CN");
  const runtime = createDesktopLocaleRuntime();
  await runtime.update({ localeOverride: "zh-CN" });
  assert.equal(runtime.getSnapshot().intl.formatMessage({ id: "desktop.open", defaultMessage: "Open OpenCraft" }), "打开 OpenCraft");
  await runtime.update({ localeOverride: "en-US" });
  assert.equal(runtime.getSnapshot().intl.formatMessage({ id: "desktop.open", defaultMessage: "Open OpenCraft" }), "Open OpenCraft");
  runtime.dispose();
});

test("host locale, persisted override, reset and multiple surfaces retain their authorities", async () => {
  const preferences = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  const a = new WorkbenchLocaleController(preferences, { ideLocale: "en-US" });
  const b = new WorkbenchLocaleController(preferences, { ideLocale: "ja-JP" });
  try {
    await Promise.all([a.initialize(), b.initialize()]);
    assert.equal(a.getSnapshot().intl.locale, "en-US");
    assert.equal(b.getSnapshot().intl.locale, "ja-JP");
    await preferences.set("locale.override", "zh-CN");
    await Promise.all([a.retry(), b.retry()]);
    assert.equal(a.getSnapshot().intl.locale, "zh-CN");
    assert.equal(b.getSnapshot().intl.locale, "zh-CN");
    await a.configure({ ideLocale: "de-DE" });
    assert.equal(a.getSnapshot().intl.locale, "zh-CN", "host updates cannot override explicit user choice");
    await preferences.reset("locale.override");
    await Promise.all([a.retry(), b.retry()]);
    assert.equal(a.getSnapshot().intl.locale, "de-DE");
    assert.equal(b.getSnapshot().intl.locale, "ja-JP");
    assert.equal(preferences.get("locale.override"), "", "host locale is not written as user preference");
  } finally { a.dispose(); b.dispose(); await preferences.close(); }
});

test("late system language query cannot overwrite a newer query or explicit preference", async () => {
  const environment = globalThis as typeof globalThis & { opencraftDesktop?: unknown };
  const saved = environment.opencraftDesktop;
  const queries: ((locale: string) => void)[] = [];
  environment.opencraftDesktop = { locale: { getSystemLocale: () => new Promise<string>(resolve => queries.push(resolve)) } };
  const preferences = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  const controller = new WorkbenchLocaleController(preferences);
  try {
    const first = controller.initialize();
    const second = controller.refreshSystemLocale();
    queries[1]!("zh-CN"); await second;
    queries[0]!("en-US"); await first;
    assert.equal(controller.getSnapshot().intl.locale, "zh-CN");
    const third = controller.refreshSystemLocale();
    await preferences.set("locale.override", "ja-JP");
    queries[2]!("en-US"); await third;
    assert.equal(controller.getSnapshot().intl.locale, "ja-JP");
  } finally { controller.dispose(); await preferences.close(); environment.opencraftDesktop = saved; }
});
