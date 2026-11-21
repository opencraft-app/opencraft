import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { temporaryWebPackagePrefix } from "../../scripts/build/package-web-server.mjs";
import { temporaryServerReleasePrefix } from "../../scripts/admin/update-server-local.mjs";

test("source packaging defaults live in the OS temporary directory", () => {
  const repository = resolve(new URL("../..", import.meta.url).pathname);
  assert.equal(temporaryWebPackagePrefix(), `${tmpdir()}/opencraft-web-package-`);
  assert.equal(temporaryServerReleasePrefix(), `${tmpdir()}/opencraft-server-release-`);
  assert.equal(temporaryWebPackagePrefix().startsWith(`${repository}/`), false);
  assert.equal(temporaryServerReleasePrefix().startsWith(`${repository}/`), false);
});
