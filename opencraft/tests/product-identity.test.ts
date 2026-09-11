import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { desktopProduct } from "../apps/workbench-electron/src/product-identity.ts";
import { resolveWorkbenchProductId } from "../apps/workbench-web/src/workbench-product.ts";
import { botConversationResourceUri, parseBotConversationViewResource } from "../packages/bot-conversation/src/view-resource.ts";
import { createConversationKey } from "@opencraft/chat-core";
import { OPENCRAFT_AGENT_CATALOG_EXTENSION } from "@opencraft/appserver-protocol";
import { OPENCRAFT_BOT_CONVERSATIONS_EXTENSION } from "../packages/appserver-protocol/src/bot-conversations.ts";
import { LIGHTVELA_TOKEN_KEY, LIGHTVELA_ACTIVE_BOT_KEY, LIGHTVELA_API_BASE } from "../plugins/lightvela-hermes/src/account/lightvela-account-service.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const json = (path: string) => JSON.parse(read(path));

test("all workspace packages use OpenCraft without old scope aliases", () => {
  assert.equal(json("package.json").name, "opencraft");
  for (const group of ["apps", "packages", "plugins"]) {
    for (const entry of readdirSync(new URL(`${group}/`, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${group}/${entry.name}/package.json`;
      if (!existsSync(new URL(path, root))) continue;
      const manifest = json(path);
      assert.match(manifest.name, /^@opencraft\//u, path);
      assert.doesNotMatch(JSON.stringify(manifest), /@vela\//u, path);
    }
  }
});

test("three hosts agree on branding but retain installed application identity", () => {
  const electron = json("apps/workbench-electron/package.json");
  const expo = json("apps/workbench-expo/app.json").expo;
  assert.equal(electron.build.productName, desktopProduct.displayName);
  assert.equal(electron.build.appId, desktopProduct.applicationId);
  assert.equal(electron.devDependencies.electron, "44.1.0");
  assert.equal(expo.name, desktopProduct.displayName);
  assert.equal(expo.scheme, "opencraft");
  assert.equal(expo.ios.bundleIdentifier, "dev.vela.workbench");
  assert.match(read("apps/workbench-web/index.html"), /<title>OpenCraft<\/title>/u);
  assert.equal(desktopProduct.profileDirectoryName, "@vela/workbench-electron");
  const main = read("apps/workbench-electron/src/main.ts");
  assert.ok(main.indexOf('app.setPath("userData"') < main.indexOf("app.requestSingleInstanceLock()"));
  assert.ok(main.indexOf("mkdirSync(userDataDirectory") < main.indexOf('app.setPath("userData"'));
  assert.match(main, /getSwitchValue\("user-data-dir"\)/u);
});

test("web product identity is normalized once for product-owned policies", () => {
  assert.equal(resolveWorkbenchProductId(undefined), "opencraft");
  assert.equal(
    resolveWorkbenchProductId({ VITE_OPENCRAFT_PRODUCT_ID: " lightvela-web " }),
    "lightvela-web",
  );
});

test("rebranding does not change conversation identity or external capability negotiation", () => {
  const key = createConversationKey("velahermes0", "20260906_125907_f05d94");
  const uri = "vela-bot:conversation?hostId=velahermes0&conversationId=20260906_125907_f05d94";
  assert.equal(botConversationResourceUri(key), uri);
  assert.deepEqual(parseBotConversationViewResource(uri), { kind: "conversation", key });
  assert.equal(OPENCRAFT_AGENT_CATALOG_EXTENSION, "vela/agents");
  assert.equal(OPENCRAFT_BOT_CONVERSATIONS_EXTENSION, "vela/bot-conversations");
  assert.match(read("apps/workbench-electron/src/daemon-client.ts"), /"vela-daemon\.sock"/u);
});

test("service-provider authentication remains in its existing namespace", () => {
  assert.equal(LIGHTVELA_API_BASE, "https://api.lightvela.ai");
  assert.equal(LIGHTVELA_TOKEN_KEY, "vela.lightvela.session-token.v1");
  assert.equal(LIGHTVELA_ACTIVE_BOT_KEY, "vela.lightvela.active-bot.v1");
});
