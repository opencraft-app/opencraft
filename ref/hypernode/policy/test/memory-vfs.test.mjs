import assert from "node:assert/strict";
import test from "node:test";
import { MemoryVFS, VfsError } from "../src/services/memory-vfs.ts";

function filesystem() {
  const value = Object.create(MemoryVFS.prototype);
  value.now = () => 1000;
  value.nodes = new Map([["/", {
    type: "directory", createdAtMs: 1000, modifiedAtMs: 1000,
  }]]);
  value.changeListeners = new Set();
  return value;
}

test("memory VFS normalizes paths without permitting virtual-root escape", () => {
  const vfs = filesystem();
  assert.equal(vfs.normalize("/workspace/./projects/../repo"), "/workspace/repo");
  assert.throws(
    () => vfs.normalize("/../host"),
    (error) => error instanceof VfsError && error.code === "EINVAL",
  );
});

test("memory VFS recursively copies files and publishes normalized changes", () => {
  const vfs = filesystem();
  const changes = [];
  vfs.onChange((paths) => changes.push(paths));
  vfs.createDirectory("/source/nested");
  vfs.writeFile("/source/nested/data.txt", new TextEncoder().encode("hello"));
  vfs.copy("/source", "/copy", true);

  assert.equal(
    new TextDecoder().decode(Uint8Array.from(vfs.readFile("/copy/nested/data.txt"))),
    "hello",
  );
  assert.deepEqual(vfs.readDirectory("/copy"), [{
    fileName: "nested", isDirectory: true, isFile: false,
  }]);
  assert.ok(changes.some((batch) => batch.includes("/copy/nested/data.txt")));
});
