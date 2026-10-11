import assert from "node:assert/strict";
import test from "node:test";
import * as routeModule from "../apps/workbench-expo/src/runtime/lightvela-site-webview";
const { lightVelaSiteTabUrl, lightVelaSiteTabForUrl } = ("default" in routeModule ? routeModule.default : routeModule) as typeof import("../apps/workbench-expo/src/runtime/lightvela-site-webview");
test("external browser destinations follow the site's three exact first-party destinations", () => {
  assert.equal(lightVelaSiteTabUrl("cn", "agents"), "https://lightvela.com/agents");
  assert.equal(lightVelaSiteTabUrl("cn", "account"), "https://lightvela.com/account");
  assert.equal(lightVelaSiteTabUrl("intl", "billing"), "https://lightvela.ai/account/billing");
  assert.equal(lightVelaSiteTabForUrl("https://lightvela.ai/agents/settings", "intl"), "agents");
  assert.equal(lightVelaSiteTabForUrl("https://lightvela.ai/account/orders", "intl"), "account");
  assert.equal(lightVelaSiteTabForUrl("https://lightvela.ai/account/billing/", "intl"), "billing");
  assert.equal(lightVelaSiteTabForUrl("https://lightvela.com/account", "intl"), null);
  assert.equal(lightVelaSiteTabForUrl("https://evil.example/account/billing", "intl"), null);
});
