import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { embeddedLocaleCatalogs, localeCatalogs } from "../apps/workbench-web/src/i18n/catalogs";
import { WorkbenchLocaleController } from "../apps/workbench-web/src/i18n/workbench-locale";

const heading = { id: "chat.companionHeading", defaultMessage: "What would you like to do together today?" };
const placeholder = { id: "chat.companionPlaceholder", defaultMessage: "Share your thoughts, or ask me to help with something" };
const thinking = { id: "chat.thinking", defaultMessage: "Thinking" };
const thought = { id: "chat.thought", defaultMessage: "Thought" };
const consoleLocales: { code: string; i18nKey: string }[] = JSON.parse(readFileSync(
  new URL("../../frontend/src/i18n/locales.json", import.meta.url), "utf8",
));

test("embedded companion copy covers every console language and follows host updates", async () => {
  const preferences = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  const controller = new WorkbenchLocaleController(preferences, { ideLocale: "en-US" }, embeddedLocaleCatalogs);
  const results = new Map<string, string[]>();
  try {
    await controller.initialize();
    for (const locale of consoleLocales) {
      assert.ok(embeddedLocaleCatalogs.some(catalog => catalog.locale === locale.i18nKey), locale.code);
      await controller.configure({ ideLocale: locale.code });
      const snapshot = controller.getSnapshot();
      assert.equal(snapshot.phase, "ready", locale.code);
      const values = [heading, placeholder, thinking, thought].map(message => snapshot.intl.formatMessage(message));
      assert.ok(values.every(value => value.length > 0 && !/OpenCraft/i.test(value)), locale.code);
      if (locale.i18nKey !== "en-US") {
        assert.notEqual(values[0], heading.defaultMessage, locale.code);
        assert.notEqual(values[1], placeholder.defaultMessage, locale.code);
        assert.notEqual(values[2], thinking.defaultMessage, locale.code);
        assert.notEqual(values[3], thought.defaultMessage, locale.code);
        const messages = await embeddedLocaleCatalogs.find(catalog => catalog.locale === locale.i18nKey)!.load();
        assert.deepEqual(values, [heading, placeholder, thinking, thought].map(message => messages[message.id]), locale.code);
      }
      results.set(locale.code, values);
    }
    assert.deepEqual(results.get("zh-SG"), results.get("zh-CN"));
    assert.match(results.get("zh-Hant")![0]!, /什麼/);
    assert.match(results.get("ja-JP")![0]!, /しましょう/);
    assert.match(results.get("ko-KR")![0]!, /함께/);
    assert.equal(preferences.get("locale.override"), "");
    assert.deepEqual(localeCatalogs.map(catalog => catalog.locale), ["en-US", "zh-CN"]);
  } finally {
    controller.dispose();
    await preferences.close();
  }
});
