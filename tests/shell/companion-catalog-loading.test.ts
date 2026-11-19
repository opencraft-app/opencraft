import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { embeddedLocaleCatalogs, localeCatalogs } from "../../apps/workbench-web/src/i18n/catalogs";
import { LocaleRuntime } from "@opencraft/i18n";

test("deferred companion catalog metadata covers every unchanged translation payload", async () => {
  const payloads = JSON.parse(
    await readFile(
      new URL("../../apps/workbench-web/src/i18n/embedded-companion-messages.json", import.meta.url),
      "utf8",
    ),
  );
  const companions = embeddedLocaleCatalogs.filter(
    (catalog) => !["en-US", "zh-CN", "ms-MY", "th-TH"].includes(catalog.locale),
  );
  assert.deepEqual(companions.map((catalog) => catalog.locale).sort(), Object.keys(payloads).sort());
  assert.deepEqual(
    localeCatalogs.map((catalog) => catalog.locale),
    ["en-US", "zh-CN"],
  );
  const runtime = new LocaleRuntime(embeddedLocaleCatalogs);
  for (const catalog of companions) {
    assert.deepEqual(await catalog.load(), payloads[catalog.locale]);
    await runtime.update({ localeOverride: catalog.locale });
    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.phase, "ready");
    assert.equal(
      snapshot.intl.formatMessage({
        id: "chat.companionHeading",
        defaultMessage: "What would you like to do together today?",
      }),
      payloads[catalog.locale]["chat.companionHeading"],
    );
  }
});
