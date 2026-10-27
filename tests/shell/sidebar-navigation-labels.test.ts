import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";
import { embeddedLocaleCatalogs } from "../../apps/workbench-web/src/i18n/catalogs";
import { shellNavigationLabels } from "../../apps/workbench-web/src/components/shell-navigation/navigation-labels";
import { shellAccountEntranceLabel } from "../../apps/workbench-web/src/components/shell-navigation/navigation-content";

const ids = ["shell.start", "shell.chat"];
const expected = {
  "zh-CN": ["开始", "会话"],
  "en-US": ["Start", "Chats"],
  "ms-MY": ["Mula", "Chat"],
  "th-TH": ["เริ่ม", "แชต"],
};
for (const [locale, labels] of Object.entries(expected)) test(`sidebar uses ${locale} compact copy and preserves complete names`, async () => {
  const messages = await embeddedLocaleCatalogs.find(catalog => catalog.locale === locale)!.load();
  const intl = createIntl({locale, messages, onError: error => { if (error.code !== "MISSING_TRANSLATION") throw error; }});
  const projected = ids.map(id => shellNavigationLabels({id, title: "Untranslated contribution title", onInvoke() {}}, intl));
  assert.deepEqual(projected.map(label => label.short), labels);
  assert.ok(projected.every(label => label.full !== "Untranslated contribution title"));
  const account = {providerId: "example.identity", snapshot: {revision: 0, phase: "anonymous" as const, name: null, avatarUrl: null, anonymousLabel: "Example account", anonymousLabelMessage: {id: "example.identity.title", defaultMessage: "Example account"}, planLabel: null, usageRemainingPercent: null, error: null}, onOpen() {}, onRefresh: async () => {}};
  if (locale !== "zh-CN") assert.notEqual(shellAccountEntranceLabel(account, intl), "员工身份");
  assert.equal(shellAccountEntranceLabel({...account, snapshot: {...account.snapshot, phase: "authenticated", name: "Synthetic employee"}}, intl), "Synthetic employee");
});

test("unknown extension names use the contribution's full and optional short copy", () => {
  const intl = createIntl({locale: "en-US", messages: {}});
  for (const id of ["third-party", "example.workspace.navigation", "example.vendor.skills", "example.vendor.storage", "opencraft.tasks.navigation", "opencraft.bot-management.navigation"]) {
    assert.deepEqual(shellNavigationLabels({id, title: "Full extension name", shortTitle: "Tools", onInvoke() {}}, intl), {full: "Full extension name", short: "Tools"});
  }
});
