import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseReleaseTag,
  productVersion,
  readProductVersions,
  setProductVersion,
} from "../../scripts/release/product-version.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const files = [
  "package.json",
  "package-lock.json",
  "apps/desktop/package.json",
  "apps/mobile/package.json",
  "apps/mobile/app.json",
  "deploy/web-server/package.json",
];

test("the repository carries one product version everywhere", () => {
  const version = productVersion(root);
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.ok(readProductVersions(root).every((entry) => entry.version === version));
});

test("release tags name the product version as beta or stable", () => {
  assert.deepEqual(parseReleaseTag("v0.2.0"), { version: "0.2.0", prerelease: false });
  assert.deepEqual(parseReleaseTag("v0.2.0-beta.12"), { version: "0.2.0", prerelease: true });
  for (const tag of ["0.2.0", "v0.2", "v0.2.0-beta.0", "v0.2.0-rc.1", "v01.2.0", "", undefined]) {
    assert.throws(() => parseReleaseTag(tag), undefined, String(tag));
  }
});

test("set rewrites every source together and check rejects any drift", (t) => {
  const copy = mkdtempSync(join(tmpdir(), "opencraft-product-version-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(join(root, file), join(copy, file));
  }
  setProductVersion(copy, "9.8.7");
  assert.equal(productVersion(copy), "9.8.7");
  const lock = JSON.parse(readFileSync(join(copy, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["apps/mobile"].version, "9.8.7");
  // Only the version fields change; formatting stays as npm writes it.
  const original = readFileSync(join(root, "apps/mobile/app.json"), "utf8");
  assert.equal(
    readFileSync(join(copy, "apps/mobile/app.json"), "utf8"),
    original.replace(`"version": "${productVersion(root)}"`, '"version": "9.8.7"'),
  );

  const drifted = JSON.parse(readFileSync(join(copy, "apps/mobile/app.json"), "utf8"));
  drifted.expo.version = "9.8.8";
  writeFileSync(join(copy, "apps/mobile/app.json"), `${JSON.stringify(drifted, null, 2)}\n`);
  assert.throws(() => productVersion(copy), /apps\/mobile\/app\.json:expo\.version = 9\.8\.8/u);
  assert.throws(() => setProductVersion(copy, "1.2"), /X\.Y\.Z/u);
});
