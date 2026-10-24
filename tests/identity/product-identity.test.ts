import assert from "node:assert/strict";

import { existsSync, readFileSync, readdirSync } from "node:fs";

import test from "node:test";

import {
  desktopPreviewProduct,
  desktopProduct,
  resolveDesktopProduct,
} from "../../apps/workbench-electron/src/product-identity.ts";

import { resolveWorkbenchProductId } from "../../apps/workbench-web/src/workbench-product.ts";

import { botConversationResourceUri, parseBotConversationViewResource } from "../../packages/bot-conversation/src/view-resource.ts";

import { createConversationKey } from "@opencraft/chat-core";

import { OPENCRAFT_BOT_CONVERSATIONS_EXTENSION } from "../../packages/appserver-protocol/src/bot-conversations.ts";


const root = new URL("../../", import.meta.url);

const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const json = (path: string) => JSON.parse(read(path));

test("all workspace packages use the OpenCraft scope", () => {
  assert.equal(json("package.json").name, "opencraft");
  for (const group of ["apps", "packages", "plugins"]) {
    for (const entry of readdirSync(new URL(`${group}/`, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${group}/${entry.name}/package.json`;
      if (!existsSync(new URL(path, root))) continue;
      const manifest = json(path);
      assert.match(manifest.name, /^@opencraft\//u, path);
    }
  }
});


test("three public hosts agree on OpenCraft branding and identity", () => {
  const electron = json("apps/workbench-electron/package.json");
  const expo = json("apps/mobile/app.json").expo;
  assert.equal(electron.build.productName, desktopProduct.displayName);
  assert.equal(electron.build.appId, desktopProduct.applicationId);
  assert.equal(
    electron.devDependencies.electron,
    json("package-lock.json").packages["node_modules/electron"].version,
  );
  assert.equal(expo.name, desktopProduct.displayName);
  assert.equal(expo.scheme, "opencraft");
  assert.equal(expo.ios.bundleIdentifier, "dev.opencraft.workbench");
  assert.match(read("apps/workbench-web/index.html"), /<title>OpenCraft<\/title>/u);
  assert.equal(desktopProduct.profileDirectoryName, "OpenCraft");
  assert.deepEqual(desktopProduct.legacyProfileDirectoryNames, []);
  const main = read("apps/workbench-electron/src/main.ts");
  assert.ok(main.indexOf("prepareDesktopDirectories") < main.indexOf("app.requestSingleInstanceLock()"));
  assert.ok(main.indexOf('appendSwitch("user-data-dir"') < main.indexOf("app.requestSingleInstanceLock()"));
  assert.ok(main.indexOf('app.setPath("userData"') < main.indexOf("app.requestSingleInstanceLock()"));
  assert.ok(main.indexOf("process.chdir(desktopPaths.runtimeDirectory)") < main.indexOf("app.requestSingleInstanceLock()"));
  assert.match(main, /getSwitchValue\("user-data-dir"\)/u);
  assert.match(main, /preparedDirectories\.status === "legacy-active"/u);
  assert.deepEqual(resolveDesktopProduct("OpenCraft"), desktopProduct);
  assert.deepEqual(resolveDesktopProduct("OpenCraft Preview"), desktopPreviewProduct);
  assert.equal(desktopPreviewProduct.applicationId, "dev.opencraft.workbench.preview");
  assert.equal(desktopPreviewProduct.profileDirectoryName, "OpenCraft Preview");
  assert.deepEqual(desktopPreviewProduct.legacyProfileDirectoryNames, []);
  assert.match(main, /resolveDesktopProduct\(executableName\)/u);
});


test("web product identity is normalized once for product-owned policies", () => {
  assert.equal(resolveWorkbenchProductId(undefined), "opencraft");
  assert.equal(
    resolveWorkbenchProductId({ VITE_OPENCRAFT_PRODUCT_ID: " example-web " }),
    "example-web",
  );
});


test("owned Bot resources preserve canonical conversation identity", () => {
  const key = createConversationKey("opaque-host", "stored-conversation");
  const uri = "opencraft-bot:conversation?hostId=opaque-host&conversationId=stored-conversation";
  assert.equal(botConversationResourceUri(key), uri);
  assert.deepEqual(parseBotConversationViewResource(uri), { kind: "conversation", key });
  assert.equal(OPENCRAFT_BOT_CONVERSATIONS_EXTENSION, "opencraft/bot-conversations");
});
