import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_CHUNK_BYTES, parseAttachmentStagingCapability } from "@opencraft/appserver-protocol";
import { LocalAttachmentStagingService } from "../../apps/local-agent-host/src/attachments/local-attachment-staging";
import { AttachmentUploadStore } from "../../apps/local-agent-host/src/attachments/attachment-upload-store";
import { resolveBrowserAttachment } from "../../apps/workbench-web/src/runtime/browser-attachment-resolver";
import { uploadAttachmentChunks } from "../../packages/workbench-runtime/src/attachment-upload";

const metadata = { clientAttachmentId: "movie", name: "movie.mp4", mimeType: "video/mp4", size: 3 * 1024 * 1024 + 17 };
const params = (uploadId = randomUUID()) => ({ ...metadata, uploadId, offset: 0, dataBase64: "AQ==" });

test("new Host capability advertises 1024 MiB and chunks; old capability stays compatible", async t => {
  const root = await mkdtemp(join(tmpdir(), "attachment-chunks-"));
  const service = new LocalAttachmentStagingService(root);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const capability = parseAttachmentStagingCapability(service.capability);
  assert.equal(capability.maxBytes, ATTACHMENT_MAX_BYTES);
  assert.equal(capability.chunkBytes, ATTACHMENT_CHUNK_BYTES);
  assert.equal(parseAttachmentStagingCapability({ version: 1, sources: ["client-bytes"], locations: ["host-file"], maxBytes: 32 * 1024 * 1024 }).chunkBytes, undefined);
  let maxRead = 0;
  const blob = new File([new Uint8Array(metadata.size).fill(71)], metadata.name, { type: metadata.mimeType });
  blob.arrayBuffer = async () => { throw new Error("Whole-file allocation is forbidden"); };
  const slice = blob.slice.bind(blob);
  blob.slice = (start = 0, end = blob.size, type) => { maxRead = Math.max(maxRead, end - start); return slice(start, end, type); };
  const resolved = await resolveBrowserAttachment(blob, { id: "movie", name: blob.name, mimeType: blob.type, size: blob.size, uri: null, lifecycle: "pending", error: null }, {
    ...capability,
    stage: async () => { throw new Error("One-shot path is forbidden"); },
    uploadChunk: p => service.handle("attachment/uploadChunk", p) as any,
    uploadCancel: uploadId => service.handle("attachment/uploadCancel", { uploadId }) as any,
  });
  assert.equal(resolved.lifecycle, "ready");
  assert.equal(maxRead, ATTACHMENT_CHUNK_BYTES);
  const stored = await readFile(decodeURIComponent(resolved.uri!.replace("file://", "")));
  assert.equal(stored.length, blob.size);
  assert(stored.every(byte => byte === 71));
  assert.deepEqual(await readdir(join(root, ".uploads")), []);
});

test("upload validation rejects oversized files, oversized chunks and mismatched offsets", async t => {
  const root = await mkdtemp(join(tmpdir(), "attachment-chunks-"));
  let commits = 0;
  const store = new AttachmentUploadStore(root, async () => { commits++; throw new Error("Unexpected commit"); });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(store.chunk({ ...params(), size: ATTACHMENT_MAX_BYTES + 1 }), /metadata or size/);
  await assert.rejects(store.chunk({ ...params(), offset: 2 }), /offset/);
  await assert.rejects(store.chunk({ ...params(), dataBase64: Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1).toString("base64") }), /chunk/);
  await assert.rejects(store.chunk({ ...params(), dataBase64: "AR==" }), /encoding/);
  const request = params();
  assert.deepEqual(await store.chunk(request), { receivedBytes: 1, ref: null });
  await assert.rejects(store.chunk(request), /offset/);
  await assert.rejects(store.chunk({ ...request, offset: 1, name: "replacement" }), /metadata/);
  assert.deepEqual(await store.cancel(request.uploadId), { removed: true });
  assert.deepEqual(await readdir(root), []);
  assert.equal(commits, 0);
});

test("concurrent admissions stay bounded and close removes partial files", async t => {
  const root = await mkdtemp(join(tmpdir(), "attachment-chunks-"));
  const store = new AttachmentUploadStore(root, async () => { throw new Error("Unexpected commit"); });
  t.after(() => rm(root, { recursive: true, force: true }));
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => store.chunk(params())));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 8);
  await store.close();
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(store.chunk(params()), /closed/);
});

test("cancellation cleans partial uploads; cancellation racing final ack preserves the ref for Draft disposal", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  await assert.rejects(uploadAttachmentChunks(metadata, async (_offset, length) => new Uint8Array(length), {
    chunkBytes: ATTACHMENT_CHUNK_BYTES,
    uploadChunk: async p => { controller.abort(); return { receivedBytes: p.offset + Buffer.from(p.dataBase64, "base64").length, ref: null }; },
    uploadCancel: async () => { cancelled++; return { removed: true }; },
  }, controller.signal), /abort/i);
  assert.equal(cancelled, 1);
  const finalController = new AbortController();
  const ref = { id: "one", name: "one", mimeType: "application/octet-stream", size: 1, location: { kind: "host-file" as const, path: "/one" } };
  const result = await uploadAttachmentChunks({ clientAttachmentId: "one", name: "one", mimeType: ref.mimeType, size: 1 }, async () => new Uint8Array([1]), {
    chunkBytes: ATTACHMENT_CHUNK_BYTES,
    uploadChunk: async () => { finalController.abort(); return { receivedBytes: 1, ref }; },
    uploadCancel: async () => { throw new Error("Committed ref must be returned"); },
  }, finalController.signal);
  assert.deepEqual(result.ref, ref);
});

test("over-limit browser files are rejected before reading", async () => {
  let read = false;
  const file = { size: ATTACHMENT_MAX_BYTES + 1, name: "too-large.bin", type: "application/octet-stream", arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } } as File;
  await assert.rejects(resolveBrowserAttachment(file, { id: "big", name: file.name, mimeType: file.type, size: file.size, uri: null, lifecycle: "pending", error: null }), /1024 MB/);
  assert.equal(read, false);
});

test("failed final commit removes its spool and allows a fresh upload", async t => {
  const root = await mkdtemp(join(tmpdir(), "attachment-chunks-"));
  const store = new AttachmentUploadStore(root, async () => { throw new Error("Synthetic storage failure"); });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(store.chunk({ ...params(), size: 1 }), /storage failure/);
  assert.deepEqual(await readdir(root), []);
  const next = params();
  assert.equal((await store.chunk(next)).receivedBytes, 1);
  await store.cancel(next.uploadId);
});

test("legacy Host limits still reject files before whole-file allocation", async () => {
  let read = false;
  const file = { size: 40 * 1024 * 1024, name: "movie.bin", type: "application/octet-stream", arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } } as File;
  await assert.rejects(resolveBrowserAttachment(file, { id: "big", name: file.name, mimeType: file.type, size: file.size, uri: null, lifecycle: "pending", error: null }, {
    maxBytes: ATTACHMENT_MAX_BYTES, stage: async () => { throw new Error("Must reject before staging"); },
  }), /32 MB/);
  assert.equal(read, false);
});
