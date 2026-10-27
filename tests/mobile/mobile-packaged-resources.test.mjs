import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { packageResourceGraph } from "../../apps/mobile/scripts/packaged-resources.mjs";

test("packaged workers and nested resources remain local and executable", () => {
  const assets = [
    { fileName: "assets/worker.js", source: 'self.postMessage(new URL("./icon.svg", "https://opencraft.invalid/").href);' },
    { fileName: "assets/icon.svg", source: "<svg/>" },
  ];
  const output = packageResourceGraph('new Worker(new URL(`./assets/worker.js`, "https://opencraft.invalid/"));', assets);
  const blobs = [];
  let workerUrl;
  vm.runInNewContext(output, { Blob: class { constructor(parts) { blobs.push(parts.join("")); } }, URL: class extends URL { static createObjectURL() { return "blob:packaged-worker"; } }, Worker: class { constructor(url) { workerUrl = url.href; } } });
  assert.equal(workerUrl, "blob:packaged-worker");
  let result;
  vm.runInNewContext(blobs[0], { self: { postMessage(value) { result = value; } }, URL });
  assert.equal(result, "data:image/svg+xml;base64,PHN2Zy8+");
});
test("unknown or cyclic worker dependencies fail without a remote-code fallback", () => {
  assert.throws(() => packageResourceGraph('new Worker("assets/a.js")', [{ fileName: "assets/a.js", source: 'import "https://example.org/code.js";' }]), /unpackaged module/);
  assert.throws(() => packageResourceGraph('new Worker("assets/a.js")', [{ fileName: "assets/a.js", source: 'new Worker("assets/a.js")' }]), /Cyclic/);
  assert.throws(() => packageResourceGraph("void 0", [{ fileName: "assets/unused.js", source: "void 0" }]), /Unpackaged/);
});
