import assert from "node:assert/strict";
import test from "node:test";

import * as languageModule from "../apps/workbench-expo/src/runtime/mobile-language";

const { parseMobileLanguagePreference, resolveMobileLanguage, siteLocaleForMobileLanguage } =
  ("default" in languageModule ? languageModule.default : languageModule) as typeof import("../apps/workbench-expo/src/runtime/mobile-language");

test("mobile language choices map simplified Chinese to the published international locale", () => {
  assert.equal(parseMobileLanguagePreference("zh-CN"), "zh-CN");
  assert.equal(parseMobileLanguagePreference("ja-JP"), "system");
  assert.equal(resolveMobileLanguage("en-US", "cn"), "en-US");
  assert.equal(siteLocaleForMobileLanguage("zh-CN", "intl"), "zh-SG");
  assert.equal(siteLocaleForMobileLanguage("en-US", "cn"), "zh-CN");
});
