import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PREVIEW_APP_ID,
  PREVIEW_PRODUCT_NAME,
  previewBuilderArguments,
} from "../../scripts/package-macos-preview.mjs";
import { signMacosPreview } from "../../scripts/sign-macos-preview.mjs";
const beforePack = createRequire(import.meta.url)("../../scripts/check-desktop-target.cjs");

test("packaging rejects a bundle and installer with different identities", async t => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-package-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist-host"));
  await writeFile(join(root, "dist-host/main.cjs"), "synthetic main");
  await writeFile(join(root, "dist-host/desktop-identity.json"), JSON.stringify({
    production: { displayName: "OpenCraft", applicationId: "dev.opencraft.workbench" },
    preview: { displayName: "OpenCraft Preview", applicationId: "dev.opencraft.workbench.preview" },
    mainSha256: createHash("sha256").update("synthetic main").digest("hex"),
  }));
  const context = { arch: process.arch === "arm64" ? 3 : 1, electronPlatformName: process.platform,
    packager: { info: { appDir: root }, appInfo: { productName: "OpenCraft", id: "dev.opencraft.workbench" } } };
  await beforePack(context);
  context.packager.appInfo.id = "com.example.other-product";
  await assert.rejects(beforePack(context), /identity mismatch/u);
  await writeFile(join(root, "dist-host/main.cjs"), "different main");
  await assert.rejects(beforePack(context), /bundle differs/u);
});

test("macOS preview packaging isolates identity, output, and signing discovery", () => {
  assert.equal(PREVIEW_APP_ID, "dev.opencraft.workbench.preview");
  assert.equal(PREVIEW_PRODUCT_NAME, "OpenCraft Preview");
  assert.deepEqual(previewBuilderArguments("arm64"), [
    "--mac",
    "zip",
    "--arm64",
    "--config.appId=dev.opencraft.workbench.preview",
    "--config.productName=OpenCraft Preview",
    "--config.directories.output=release/preview",
    "--config.artifactName=OpenCraft-Preview-${version}-${os}-${arch}.${ext}",
  ]);
  assert.throws(() => previewBuilderArguments("universal"), /arm64 or x64/u);
});

test("workspace install scripts are explicitly version-pinned and enforced", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.allowScripts).filter(([, allowed]) => allowed)), {
    "@parcel/watcher@2.6.0": true,
    "esbuild@0.25.12": true,
    "esbuild@0.28.2": true,
    "fsevents@2.3.3": true,
    "node-pty@1.1.0": true,
  });
  assert.match(await readFile(new URL("../../.npmrc", import.meta.url), "utf8"), /^strict-allow-scripts=true\n$/u);
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
