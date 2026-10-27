import assert from "node:assert/strict";
import test from "node:test";
import { mobilePreviewAssetUri } from "../../apps/mobile/src/runtime/mobile-preview-asset.ts";

test("Expo Go asset resolution preserves the manifest directory and asset query", () => {
  const asset = "http://preview.example/assets/?unstable_path=./apps/mobile/assets/mobile-workbench.html&platform=ios&hash=abc";
  assert.equal(mobilePreviewAssetUri(asset, "exp://preview.example/mobile/"), asset.replace("/assets/", "/mobile/assets/"));
  assert.equal(mobilePreviewAssetUri(asset, "exp://preview.example/mobile/--/route"), asset.replace("/assets/", "/mobile/assets/"));
  const secure = asset.replace("http:", "https:");
  assert.equal(mobilePreviewAssetUri(secure, "exps://preview.example/mobile/"), secure.replace("/assets/", "/mobile/assets/"));
});

test("root previews, embedded files and unrelated asset origins retain their source", () => {
  for (const [asset, manifest] of [
    ["http://preview.example/assets/icon.png", "exp://preview.example/"],
    ["http://preview.example/mobile/assets/icon.png", "exp://preview.example/mobile/"],
    ["https://cdn.example/assets/icon.png", "exps://preview.example/mobile/"],
    ["file:///bundle/mobile-workbench.html", "exp://preview.example/mobile/"],
    ["http://preview.example/assets/icon.png", "invalid"],
    ["http://preview.example/assets/icon.png", undefined],
  ]) assert.equal(mobilePreviewAssetUri(asset!, manifest), asset);
});
