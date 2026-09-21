import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PREVIEW_APP_ID,
  PREVIEW_PRODUCT_NAME,
  previewBuilderArguments,
} from "../scripts/package-macos-preview.mjs";
import { signMacosPreview } from "../scripts/sign-macos-preview.mjs";

test("macOS preview packaging isolates identity, output, and signing discovery", () => {
  assert.equal(PREVIEW_APP_ID, "ai.lightvela.vela.preview");
  assert.equal(PREVIEW_PRODUCT_NAME, "OpenCraft Preview");
  assert.deepEqual(previewBuilderArguments("arm64"), [
    "--mac",
    "zip",
    "--arm64",
    "--config.appId=ai.lightvela.vela.preview",
    "--config.productName=OpenCraft Preview",
    "--config.directories.output=release/preview",
    "--config.artifactName=OpenCraft-Preview-${version}-${os}-${arch}.${ext}",
  ]);
  assert.throws(() => previewBuilderArguments("universal"), /arm64 or x64/u);
});

test("workspace install scripts are explicitly version-pinned and enforced", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.allowScripts, {
    "@parcel/watcher@2.6.0": true,
    "esbuild@0.25.12": true,
    "esbuild@0.28.2": true,
    "fsevents@2.3.3": true,
    "node-pty@1.1.0": true,
  });
  assert.match(await readFile(new URL("../.npmrc", import.meta.url), "utf8"), /^strict-allow-scripts=true\n$/u);
});

test("preview signing normalizes nested code, signs helpers, seals the app, then verifies", async () => {
  const calls = [];
  await signMacosPreview({
    appPath: "/tmp/OpenCraft Preview.app",
    entitlementsPath: "/tmp/entitlements.plist",
    execFileImpl: async (command, args) => { calls.push([command, args]); },
  });
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[0], ["codesign", [
    "--force", "--deep", "--sign", "-", "--timestamp=none", "--options", "runtime",
    "--entitlements", "/tmp/entitlements.plist", "/tmp/OpenCraft Preview.app",
  ]]);
  assert.equal(calls[1][1].at(-1), "/tmp/OpenCraft Preview.app/Contents/Frameworks/OpenCraft Preview Helper.app");
  assert.equal(calls[4][1].at(-1), "/tmp/OpenCraft Preview.app/Contents/Frameworks/OpenCraft Preview Helper (Renderer).app");
  assert.deepEqual(calls[5], ["codesign", [
    "--force", "--sign", "-", "--timestamp=none", "--options", "runtime",
    "--entitlements", "/tmp/entitlements.plist", "/tmp/OpenCraft Preview.app",
  ]]);
  assert.deepEqual(calls[6], ["codesign", [
    "--verify", "--deep", "--strict", "--verbose=2", "/tmp/OpenCraft Preview.app",
  ]]);
});
