import * as protocol from "@opencraft/appserver-protocol";
import * as uploadRuntime from "../../packages/workbench-runtime/src/attachment-upload";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { compileSubmitIntent } from "@opencraft/composer-appserver";
import { asHostId, createConversationKey } from "@opencraft/chat-core";
import type { AttachmentStageParams, AttachmentStageResponse } from "@opencraft/appserver-protocol";
import type { ComposerAttachment, SubmitIntent } from "@opencraft/composer-core";

const sourceUri = "file:///picker/photo.heic";
const convertedUri = "file:///cache/photo.jpg";
const imageLimit = 20 * 1024 * 1024;

type FileRecord = { size: number; base64: string };
const files = new Map<string, FileRecord>();
const deleted: string[] = [];
let convertedResultUri = convertedUri;
let afterConversion: (() => void) | null = null;

class FakeFile {
  constructor(private readonly uri: string) {}
  get size(): number { return files.get(this.uri)?.size ?? 0; }
  async base64(): Promise<string> {
    const record = files.get(this.uri);
    if (!record) throw new Error("Missing file");
    return record.base64;
  }
  open(mode: string) {
    assert.equal(mode, "r");
    return { offset: 0, readBytes(length: number) { return new Uint8Array(length).fill(37); }, close() {} };
  }
  delete(): void { deleted.push(this.uri); }
}

// Compile the platform resolver against tiny native-module fakes. The test
// exercises its real cleanup path without loading Expo's iOS runtime in Node.
const entry = fileURLToPath(new URL("../../apps/workbench-expo/src/runtime/native-attachment-resolver.ts", import.meta.url));
const compiled = await build({ entryPoints: [entry], bundle: false, platform: "node", format: "cjs", write: false });
const resolverModule: { exports: Record<string, unknown> } = { exports: {} };
const platformRequire = (id: string): unknown => {
  if (id === "expo-file-system") return { File: FakeFile, FileMode: { ReadOnly: "r" } };
  if (id === "expo-image-manipulator") return {
    SaveFormat: { JPEG: "jpeg" },
    manipulateAsync: async () => {
      afterConversion?.();
      return { uri: convertedResultUri };
    },
  };
  if (id === "@opencraft/appserver-protocol") return protocol;
  if (id === "@opencraft/workbench-runtime") return uploadRuntime;
  throw new Error(`Unexpected native dependency: ${id}`);
};
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(
  platformRequire, resolverModule, resolverModule.exports,
);
const resolveNativeAttachment = resolverModule.exports.resolveNativeAttachment as (
  source: { uri: string; name: string; mimeType: string; size: number },
  pending: ComposerAttachment,
  staging: ({ maxBytes: number; stage(request: AttachmentStageParams): Promise<AttachmentStageResponse> } & Partial<uploadRuntime.AttachmentChunkPort>) | null,
  signal?: AbortSignal,
) => Promise<ComposerAttachment>;

const pending: ComposerAttachment = {
  id: "selected-photo", name: "photo.heic", mimeType: "image/heic", size: 4,
  uri: null, lifecycle: "pending", error: null,
};
const source = { uri: sourceUri, name: "photo.heic", mimeType: "image/heic", size: 4 };

function reset(convertedSize = 4): void {
  files.clear();
  files.set(sourceUri, { size: 4, base64: "aGVpYw==" });
  files.set(convertedUri, { size: convertedSize, base64: "anBlZw==" });
  deleted.length = 0;
  convertedResultUri = convertedUri;
  afterConversion = null;
}

test("native HEIC conversion removes only its temporary JPEG after encoding", async () => {
  reset();
  const resolved = await resolveNativeAttachment(source, pending, null);
  assert.equal(resolved.lifecycle, "ready");
  assert.equal(resolved.uri, "data:image/jpeg;base64,anBlZw==");
  assert.equal(resolved.name, "photo.jpg");
  assert.equal(resolved.metadata?.transport, "inline-image-url");
  assert.deepEqual(deleted, [convertedUri]);
  assert.equal(files.has(sourceUri), true);
});

test("native HEIC conversion cleans its temporary JPEG after cancellation or size rejection", async () => {
  reset();
  const controller = new AbortController();
  afterConversion = () => controller.abort();
  await assert.rejects(resolveNativeAttachment(source, pending, null, controller.signal));
  assert.deepEqual(deleted, [convertedUri]);

  reset(imageLimit + 1);
  await assert.rejects(resolveNativeAttachment(source, pending, null), /too large/);
  assert.deepEqual(deleted, [convertedUri]);
});

test("a converter returning the picker URI cannot delete the original photo", async () => {
  reset();
  convertedResultUri = sourceUri;
  await resolveNativeAttachment(source, pending, null);
  assert.deepEqual(deleted, []);
});

test("a native file picker result stages through the Host and compiles into the shared send payload", async () => {
  reset();
  const uri = "file:///picker/report.pdf";
  files.set(uri, { size: 4, base64: "AQIDBA==" });
  const stageRequests: AttachmentStageParams[] = [];
  const resolved = await resolveNativeAttachment(
    { uri, name: "report.pdf", mimeType: "application/pdf", size: 4 },
    { ...pending, id: "selected-file", name: "report.pdf", mimeType: "application/pdf" },
    {
      maxBytes: 32 * 1024 * 1024,
      async stage(request) {
        stageRequests.push(request);
        return { ref: {
          id: "staged-file",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 4,
          location: { kind: "host-file", path: "/home/agent/report (final).pdf" },
        } };
      },
    },
  );
  assert.deepEqual(stageRequests, [{
    clientAttachmentId: "selected-file",
    name: "report.pdf",
    mimeType: "application/pdf",
    size: 4,
    source: { kind: "client-bytes", dataBase64: "AQIDBA==" },
  }]);
  assert.equal(resolved.lifecycle, "ready");
  assert.equal(resolved.metadata?.transport, "opencraft-attachment-staging");

  const intent: SubmitIntent = {
    commandId: "send-file",
    clientMessageId: "message-file",
    target: { type: "existing-thread", key: createConversationKey(asHostId("hermes:test"), "thread-1") },
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Read this" }] }] },
    attachments: [resolved],
    context: [],
    selections: {},
    options: { autoContext: true },
    createdAt: 1,
  };
  assert.deepEqual(compileSubmitIntent(intent).input, [
    { type: "text", text: "Read this", text_elements: [] },
    { type: "mention", name: "report.pdf", path: "/home/agent/report (final).pdf" },
  ]);
});

test("native large files use bounded FileHandle reads instead of whole-file base64", async () => {
  reset();
  const uri = "file:///picker/movie.mp4";
  const size = 40 * 1024 * 1024;
  files.set(uri, { size, base64: "must-not-be-used" });
  let received = 0;
  const result = await resolveNativeAttachment({ uri, name: "movie.mp4", mimeType: "video/mp4", size },
    { ...pending, id: "large-movie", size }, {
      maxBytes: protocol.ATTACHMENT_MAX_BYTES, chunkBytes: protocol.ATTACHMENT_CHUNK_BYTES,
      stage: async () => { throw new Error("Whole file staging is forbidden"); },
      uploadCancel: async () => ({ removed: true }),
      uploadChunk: async p => {
        const bytes = Buffer.from(p.dataBase64, "base64");
        assert(bytes.length <= protocol.ATTACHMENT_CHUNK_BYTES);
        assert.equal(p.offset, received);
        assert.equal(bytes[0], 37);
        received += bytes.length;
        return { receivedBytes: received, ref: received === size ? {
          id: p.clientAttachmentId, name: p.name, mimeType: p.mimeType, size,
          location: { kind: "host-file", path: "/attachments/movie.mp4" },
        } : null };
      },
    });
  assert.equal(received, size);
  assert.equal(result.lifecycle, "ready");
});
