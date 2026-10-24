import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { AttachmentStageParams } from "@opencraft/appserver-protocol";
import { SshAttachmentStagingService } from "../../apps/opencraft-daemon/src/ssh-attachment-staging.js";
import { fixtureFiles } from "../fixtures/ssh-files.js";
function request(id: string, bytes = Buffer.from("hello"), name = '文档 "x".bin'): AttachmentStageParams {
  return { clientAttachmentId: id, name, mimeType: "application/octet-stream", size: bytes.length, source: { kind: "client-bytes", dataBase64: bytes.toString("base64") } };
}
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ssh-staging-"));
  const state = join(root, "state"), home = join(root, "remote-home");
  const calls: string[] = [];
  const faults = { remove: false, commit: false, retained: false };
  const files = fixtureFiles();
  const originalCommit = files.commit.bind(files), originalUpload = files.upload.bind(files);
  files.upload = async (source, target) => { calls.push("sftp:put"); await originalUpload(source, target); };
  files.commit = async (source, target) => { await originalCommit(source, target); if (faults.commit) throw new Error("Unknown commit outcome"); };
  const rpc = async (method: string, p: Record<string, unknown>) => {
    calls.push(method);
    const path = String(p.path);
    switch (method) {
      case "fs/createDirectory": await mkdir(path, { recursive: true }); return {};
      case "fs/getMetadata": { const s = await lstat(path); return { isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink() }; }
      case "fs/writeFile": { const data = Buffer.from(String(p.dataBase64), "base64"); assert.ok(data.length <= 10 * 1024 * 1024); await writeFile(path, data); return {}; }
      case "fs/readFile": return { dataBase64: (await readFile(path)).toString("base64") };
      case "fs/remove": if (faults.remove) throw new Error("Remote is disconnected"); await rm(path, { force: true, recursive: true }); return {};
      default: throw new Error(`Unexpected method ${method}`);
    }
  };
  const create = (codexHome = home) => { const service = new SshAttachmentStagingService({ directory: state, namespace: "a".repeat(64), files, request: rpc, isRetained: () => faults.retained }); assert.equal(service.initialize(codexHome), true); return service; };
  const service = create();
  t.after(async () => { await service.close(); await rm(root, { force: true, recursive: true }); });
  return { root, state, home, calls, faults, files, service, create };
}

test("small binary/Unicode filenames use native RPC; >10 MiB and 32 MiB use actual SFTP batches", async t => {
  const { calls, service, state } = await setup(t);
  for (const size of [1024, 10 * 1024 * 1024, 13 * 1024 * 1024, 32 * 1024 * 1024]) {
    calls.length = 0;
    const bytes = randomBytes(size), input = request(`file-${size}`, bytes);
    const response = await service.stage(input);
    const path = response.ref.location.kind === "host-file" ? response.ref.location.path : "";
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(calls.includes("fs/writeFile"), size <= 10 * 1024 * 1024);
    assert.equal(calls.includes("sftp:put"), size > 10 * 1024 * 1024);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await service.stage(input), response);
    assert.deepEqual(await service.referenceForHostPath(input.name, path), response.ref);
    assert.deepEqual(await service.remove(input.clientAttachmentId), { removed: true });
    assert.deepEqual(await service.remove(input.clientAttachmentId), { removed: false });
    await assert.rejects(service.referenceForHostPath(input.name, path), /not committed/u);
  }
  assert.deepEqual(await readdir(state), []);
});

test("unknown commit replays exact bytes after reopening; conflicts never overwrite", async t => {
  const { service, create, faults } = await setup(t);
  const input = request("unknown");
  faults.commit = true;
  await assert.rejects(service.stage(input), /Unknown commit/u);
  faults.commit = false;
  const restored = create();
  const result = await restored.stage(input);
  await assert.rejects(restored.stage(request("unknown", Buffer.from("other"))), /different/u);
  const path = result.ref.location.kind === "host-file" ? result.ref.location.path : "";
  assert.deepEqual(await readFile(path), Buffer.from("hello"));
  await writeFile(path, "altered");
  await assert.rejects(restored.referenceForHostPath(input.name, path), /committed bytes/u);
});

test("concurrent same-ID uploads serialize one write; removal waits for the upload", async t => {
  const { service, calls, files } = await setup(t);
  const input = request("concurrent");
  const results = await Promise.all([service.stage(input), service.stage(input)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(calls.filter(method => method === "fs/writeFile").length, 1);
  const next = request("remove-during-upload");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const commit = files.commit.bind(files);
  files.commit = async (part, path) => { enter(); await released; await commit(part, path); };
  const uploading = service.stage(next);
  await entered;
  const removing = service.remove(next.clientAttachmentId);
  release();
  const uploaded = await uploading;
  await removing;
  assert.equal(uploaded.ref.location.kind, "host-file");
  if (uploaded.ref.location.kind === "host-file") await assert.rejects(readFile(uploaded.ref.location.path));
});

test("failed removal persists and is retried; retained files and symlinks cannot be removed/sent", async t => {
  const { service, faults, home } = await setup(t);
  const response = await service.stage(request("remove-me"));
  faults.remove = true;
  await assert.rejects(service.remove("remove-me"), /disconnected/u);
  await assert.rejects(service.stage(request("remove-me")), /removal is pending/u);
  faults.remove = false;
  await service.stage(request("new-file"));
  const path = response.ref.location.kind === "host-file" ? response.ref.location.path : "";
  await assert.rejects(readFile(path));
  const retained = await service.stage(request("retained")); faults.retained = true;
  await assert.rejects(service.remove("retained"), /Sent attachments/u);
  const kept = retained.ref.location.kind === "host-file" ? retained.ref.location.path : "";
  assert.equal((await readFile(kept)).toString(), "hello");
  faults.retained = false;
  await rm(kept); await symlink(join(home, "outside"), kept);
  await assert.rejects(service.referenceForHostPath(retained.ref.name, kept), /unavailable/u);
});

test("invalid/oversized requests are rejected before remote mutations and paths stay Host-owned", async t => {
  const { service, calls, home } = await setup(t);
  for (const input of [request("../bad"), { ...request("large"), size: 33 * 1024 * 1024 },
    { ...request("mismatch"), size: 6 }, request("empty", Buffer.alloc(0)),
    { ...request("invalid"), source: { kind: "client-bytes", dataBase64: "Y Q==" } }]) await assert.rejects(service.stage(input as AttachmentStageParams));
  assert.deepEqual(calls, []);
  assert.equal(await service.referenceForHostPath("ordinary", "/workspace/README.md"), null);
  assert.equal(service.initialize("relative"), false);
  assert.equal(service.initialize(home + "-other"), false);
  const outside = join(home, "outside"); await mkdir(outside, { recursive: true });
  const root = join(home, "attachments", `opencraft-${"a".repeat(64)}`);
  await mkdir(join(home, "attachments"), { recursive: true }); await symlink(outside, root);
  await assert.rejects(service.stage(request("link")), /owned storage/u);
  assert.deepEqual(await readdir(outside), []);
});

test("chunked files above the old limit reach SSH storage through SFTP with exact content", async t => {
  const { service, calls } = await setup(t);
  const size = 40 * 1024 * 1024 + 19;
  const bytes = randomBytes(size);
  const uploadId = "ssh_chunked_upload_test";
  let response: any;
  for (let offset = 0; offset < size; offset += 1024 * 1024) {
    response = await service.handle("attachment/uploadChunk", {
      clientAttachmentId: "large-movie", name: "录屏.mp4", mimeType: "video/mp4", size, uploadId, offset,
      dataBase64: bytes.subarray(offset, offset + 1024 * 1024).toString("base64"),
    });
    assert.equal(response.receivedBytes, Math.min(size, offset + 1024 * 1024));
    if (response.receivedBytes < size) assert.equal(response.ref, null);
  }
  assert.equal(response.ref.size, size);
  assert.deepEqual(await readFile(response.ref.location.path), bytes);
  assert.equal(calls.filter(call => call === "sftp:put").length, 1);
  assert.equal(calls.includes("fs/writeFile"), false);
  assert.deepEqual(await service.referenceForHostPath("录屏.mp4", response.ref.location.path), response.ref);
});

test("stale or corrupt unrelated manifests cannot block new uploads; direct access still rejects them", async t => {
  const { service, state, home, create } = await setup(t);
  const old = await service.stage(request("old-home"));
  const oldPath = old.ref.location.kind === "host-file" ? old.ref.location.path : "";
  const oldManifest = await readFile(join(state, "old-home.json"), "utf8");
  const current = create(home + "-new");
  t.after(() => current.close());
  const result = await current.stage(request("fresh", Buffer.from("new bytes")));
  assert.equal(result.ref.location.kind, "host-file");
  if (result.ref.location.kind === "host-file") assert.equal((await readFile(result.ref.location.path)).toString(), "new bytes");
  await writeFile(join(state, "corrupt.json"), "{invalid");
  await current.stage(request("after-corrupt"));
  await assert.rejects(current.stage(request("old-home")), /Invalid SSH attachment manifest/u);
  await assert.rejects(current.remove("old-home"), /Invalid SSH attachment manifest/u);
  await assert.rejects(current.remove("corrupt"), SyntaxError);
  assert.equal(await readFile(join(state, "old-home.json"), "utf8"), oldManifest);
  assert.equal(await readFile(join(state, "corrupt.json"), "utf8"), "{invalid");
  assert.equal((await readFile(oldPath)).toString(), "hello");
});
