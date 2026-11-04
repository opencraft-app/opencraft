import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, stat, writeFile, rm, link, rename, utimes, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GenerationArtifactDigests } from "../../apps/codex-core/src/generation-artifact-digest.js";

const hash = (content: string) => createHash("sha256").update(content).digest("hex");

test("unchanged artifact aliases reuse content reads while every request rechecks the descriptor and path", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-artifact-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "program"), alias = join(root, "alias");
  await writeFile(path, "fixed program"); await link(path, alias);
  let reads = 0, opened = 0, pathChecks = 0;
  const cache = new GenerationArtifactDigests({
    async open(path) {
      opened++; const file = await open(path, "r"); const read = file.createReadStream.bind(file);
      file.createReadStream = options => { reads++; return read(options); }; return file;
    },
    async stat(path) { pathChecks++; return stat(path, { bigint: true }); },
  });
  for (let n = 0; n < 4; n++) assert.equal(await cache.sha256(n % 2 ? alias : path), hash("fixed program"));
  assert.equal(reads, 1); assert.equal(opened, 4); assert.equal(pathChecks, 4);
  await chmod(path, 0o600);
  assert.equal(await cache.sha256(path), hash("fixed program")); assert.equal(reads, 2);
});

test("same-size writes with restored mtime and atomic replacement cannot reuse a stale digest", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-artifact-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "program"), replacement = join(root, "replacement"), cache = new GenerationArtifactDigests();
  await writeFile(path, "first"); const original = await stat(path);
  assert.equal(await cache.sha256(path), hash("first"));
  await writeFile(path, "other"); await utimes(path, original.atime, original.mtime);
  assert.equal(await cache.sha256(path), hash("other"));
  await writeFile(replacement, "third"); await utimes(replacement, original.atime, original.mtime); await rename(replacement, path);
  assert.equal(await cache.sha256(path), hash("third"));
});

test("a path replaced during a cached observation is rejected and the replacement is read on retry", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-artifact-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "program"), replacement = join(root, "replacement"); let replace = false;
  await writeFile(path, "first"); await writeFile(replacement, "other");
  const cache = new GenerationArtifactDigests({ open: path => open(path, "r"), async stat(path) {
    if (replace) { replace = false; await rename(replacement, path); }
    return stat(path, { bigint: true });
  } });
  assert.equal(await cache.sha256(path), hash("first")); replace = true;
  await assert.rejects(cache.sha256(path), /changed during observation/u);
  assert.equal(await cache.sha256(path), hash("other"));
});

test("writes during the first read are rejected and non-regular artifacts fail closed", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-artifact-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "program"); await writeFile(path, "first"); let mutate = true;
  const cache = new GenerationArtifactDigests({ open: path => open(path, "r"), async stat(path) {
    if (mutate) { mutate = false; await writeFile(path, "other"); }
    return stat(path, { bigint: true });
  } });
  await assert.rejects(cache.sha256(path), /changed during observation/u);
  assert.equal(await cache.sha256(path), hash("other"));
  await assert.rejects(cache.sha256(root), /regular file/u);
});

test("bounded entries discard old content digests", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-artifact-")); t.after(() => rm(root, { recursive: true, force: true }));
  let reads = 0;
  const cache = new GenerationArtifactDigests({ async open(path) {
    const file = await open(path, "r"), read = file.createReadStream.bind(file);
    file.createReadStream = options => { reads++; return read(options); }; return file;
  }, stat: path => stat(path, { bigint: true }) });
  for (let n = 0; n < 65; n++) { const path = join(root, String(n)); await writeFile(path, String(n)); assert.equal(await cache.sha256(path), hash(String(n))); }
  assert.equal(await cache.sha256(join(root, "0")), hash("0")); assert.equal(reads, 66);
});
