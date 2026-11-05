import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { BlobResourceService } from "@opencraft/blob-resources";
import type { ComposerAttachment } from "@opencraft/composer-core";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

import {
  BrowserAttachmentError,
  MAX_INLINE_BROWSER_IMAGE_BYTES,
  MAX_STAGED_BROWSER_FILE_BYTES,
  resolveBrowserAttachment,
  resolveBrowserAttachmentForHost,
} from "../../apps/workbench-web/src/runtime/browser-attachment-resolver";
import {
  appServerMediaPath,
  createAppServerMediaSourceLoader,
  mediaMimeType,
} from "../../apps/workbench-web/src/runtime/appserver-media-loader";
import { resolveConversationMediaSource } from "../../apps/workbench-web/src/components/conversation/conversation-media-source";

function pending(file: File): ComposerAttachment {
  return {
    id: "attachment-1",
    name: file.name,
    mimeType: file.type,
    size: file.size,
    uri: null,
    lifecycle: "pending",
    error: null,
  };
}

test("browser images become host-independent inline image URLs", async () => {
  const file = new File([new Uint8Array([1, 2, 3])], "paste.png", {
    type: "image/png",
  });
  const resolved = await resolveBrowserAttachment(file, pending(file));

  assert.equal(resolved.uri, "data:image/png;base64,AQID");
  assert.equal(resolved.lifecycle, "ready");
  assert.equal(resolved.error, null);
  assert.deepEqual(resolved.metadata, {
    source: "browser-inline",
    transport: "inline-image-url",
    originalBytes: 3,
    compression: "not-requested",
  });
});

test("unsupported image formats fail before the Composer marks them ready", async () => {
  const file = new File(["vector"], "drawing.svg", { type: "image/svg+xml" });
  await assert.rejects(
    () => resolveBrowserAttachment(file, pending(file)),
    (error: unknown) => error instanceof BrowserAttachmentError
      && error.code === "UNSUPPORTED_IMAGE_TYPE",
  );
});

test("HEIC camera photos use the converted JPEG even when conversion grows the file", async () => {
  const file = new File(["heic"], "IMG_0001.HEIC", { type: "image/heic" });
  const jpeg = new Blob(["larger jpeg derivative"], { type: "image/jpeg" });
  const resolved = await resolveBrowserAttachment(file, pending(file), { stage: null }, {
    compress: async () => ({ blob: jpeg, changed: true, reason: "transcoded" }),
  });
  assert.equal(resolved.lifecycle, "ready");
  assert.equal(resolved.name, "IMG_0001.jpg");
  assert.equal(resolved.mimeType, "image/jpeg");
  assert.equal(resolved.size, jpeg.size);
  assert.match(resolved.uri ?? "", /^data:image\/jpeg;base64,/u);
  assert.equal(resolved.metadata?.compression, "transcoded");
});

test("HEIC without a browser codec fails with a specific recoverable error", async () => {
  const file = new File(["heic"], "IMG_0001.HEIC", { type: "image/heic" });
  await assert.rejects(
    () => resolveBrowserAttachment(file, pending(file), { stage: null }, {
      compress: async (source) => ({ blob: source, changed: false, reason: "codec-unavailable" }),
    }),
    (error: unknown) => error instanceof BrowserAttachmentError
      && error.code === "UNSUPPORTED_IMAGE_TYPE"
      && error.message.includes("could not convert the HEIC"),
  );
});

test("HEIC filename recovers missing browser MIME before image processing", async () => {
  const file = new File(["heic"], "IMG_0002.heif");
  const resolved = await resolveBrowserAttachment(file, pending(file), { stage: null }, {
    compress: async (source) => {
      assert.equal(source.type, "image/heif");
      return { blob: new Blob(["jpeg"], { type: "image/jpeg" }), changed: true, reason: "transcoded" };
    },
  });
  assert.equal(resolved.name, "IMG_0002.jpg");
  assert.equal(resolved.mimeType, "image/jpeg");
});

test("HEIC JPEG derivative over the inline cap is rejected before base64 allocation", async () => {
  const file = new File(["heic"], "IMG_0003.HEIC", { type: "image/heic" });
  let read = false;
  const tooLarge = {
    type: "image/jpeg",
    size: MAX_INLINE_BROWSER_IMAGE_BYTES + 1,
    arrayBuffer: async () => { read = true; return new ArrayBuffer(0); },
  } as Blob;
  await assert.rejects(
    () => resolveBrowserAttachment(file, pending(file), { stage: null }, {
      compress: async () => ({ blob: tooLarge, changed: true, reason: "transcoded" }),
    }),
    (error: unknown) => error instanceof BrowserAttachmentError && error.code === "IMAGE_TOO_LARGE",
  );
  assert.equal(read, false);
});

test("compressed WebP keeps a filename extension that matches its MIME type", async () => {
  const file = new File([new Uint8Array([1, 2])], "photo.webp", { type: "image/webp" });
  const resolved = await resolveBrowserAttachment(file, pending(file), { stage: null }, {
    compress: async () => ({
      blob: new Blob([new Uint8Array([3])], { type: "image/webp" }),
      changed: true,
      reason: "compressed",
    }),
  });
  assert.equal(resolved.name, "photo.webp");
  assert.equal(resolved.mimeType, "image/webp");
  assert.equal(resolved.uri, "data:image/webp;base64,Aw==");
});

test("the browser resolver stages non-image files through the semantic Host attachment port", async () => {
  const text = new File(["hello"], "note.txt", { type: "text/plain" });
  const stages: unknown[] = [];
  const resolved = await resolveBrowserAttachment(text, pending(text), {
    stage: async (request) => {
      stages.push(request);
      return {
        ref: {
          id: request.clientAttachmentId,
          name: request.name,
          mimeType: request.mimeType,
          size: request.size,
          location: {
            kind: "host-file" as const,
            path: "/host-owned/attachments/attachment-1/note.txt",
          },
        },
      };
    },
  });

  assert.deepEqual(stages, [{
    clientAttachmentId: "attachment-1",
    name: "note.txt",
    mimeType: "text/plain",
    size: 5,
    source: { kind: "client-bytes", dataBase64: "aGVsbG8=" },
  }]);
  assert.equal(
    resolved.uri,
    "file:///host-owned/attachments/attachment-1/note.txt",
  );
  assert.equal(resolved.lifecycle, "ready");
  assert.deepEqual(resolved.metadata, {
    source: "browser-host-staged",
    transport: "opencraft-attachment-staging",
    attachmentRef: {
      id: "attachment-1",
      name: "note.txt",
      mimeType: "text/plain",
      size: 5,
      location: {
        kind: "host-file",
        path: "/host-owned/attachments/attachment-1/note.txt",
      },
    },
  });
});

test("the browser resolver reports unavailable Host staging and empty attachments", async () => {
  const text = new File(["hello"], "note.txt", { type: "text/plain" });
  await assert.rejects(
    () => resolveBrowserAttachment(text, pending(text)),
    (error: unknown) => error instanceof BrowserAttachmentError
      && error.code === "HOST_FILE_STAGING_UNAVAILABLE",
  );

  const empty = new File([], "empty.png", { type: "image/png" });
  await assert.rejects(
    () => resolveBrowserAttachment(empty, pending(empty)),
    (error: unknown) => error instanceof BrowserAttachmentError
      && error.code === "EMPTY_ATTACHMENT",
  );
});

test("the browser resolver bounds staged file allocation before reading bytes", async () => {
  let read = false;
  const oversized = {
    name: "archive.zip",
    type: "application/zip",
    size: MAX_STAGED_BROWSER_FILE_BYTES + 1,
    arrayBuffer: async () => {
      read = true;
      return new ArrayBuffer(0);
    },
  } as File;

  await assert.rejects(
    () => resolveBrowserAttachment(oversized, pending(oversized), {
      directory: "/tmp/opencraft-attachments",
      writeFile: async () => undefined,
    }),
    (error: unknown) => error instanceof BrowserAttachmentError
      && error.code === "FILE_TOO_LARGE",
  );
  assert.equal(read, false);
});

test("the browser resolver bounds JSON-RPC expansion before reading bytes", async () => {
  let read = false;
  const oversized = {
    name: "camera.png",
    type: "image/png",
    size: MAX_INLINE_BROWSER_IMAGE_BYTES + 1,
    arrayBuffer: async () => {
      read = true;
      return new ArrayBuffer(0);
    },
  } as File;

  await assert.rejects(
    () => resolveBrowserAttachment(oversized, pending(oversized)),
    (error: unknown) => error instanceof BrowserAttachmentError
      && error.code === "IMAGE_TOO_LARGE",
  );
  assert.equal(read, false);
});

test("Markdown media paths remain Host filesystem paths, not browser file URLs", () => {
  assert.equal(appServerMediaPath("file:///workspace/demo/a%20b.png#preview"), "/workspace/demo/a b.png");
  assert.equal(appServerMediaPath("file:///C:/workspace/demo/a.png"), "C:/workspace/demo/a.png");
  assert.equal(appServerMediaPath("https://example.com/a.png"), null);
  assert.equal(mediaMimeType("/tmp/diagram.SVG"), "image/svg+xml");
  assert.equal(mediaMimeType("/tmp/unknown.bin"), "application/octet-stream");
});

test("Markdown media retains shared snapshots and URLs until the resource owner disposes", async () => {
  let reads = 0;
  const runtime = {
    resources: {
      host: {},
      fileSystem: {
        async readFile(path: string) {
          reads += 1;
          assert.equal(path, "/workspace/demo/preview.png");
          return { dataBase64: "AQID" };
        },
      },
    },
  } as unknown as AppServerWorkbenchRuntime;
  const ctx = new Context(); const fiber = ctx.plugin(BlobResourceService); await fiber;
  const load = createAppServerMediaSourceLoader(runtime, ctx.blobResources, "ssh:demo");
  const request = {
    conversationId: "thread-1",
    cwd: "/workspace/demo",
    documentId: "message-1",
    hostId: "ssh:demo",
    resourceKind: "workspace-file" as const,
    resolvedTarget: "file:///workspace/demo/preview.png",
    source: "preview.png",
  };

  assert.equal(load.getSnapshot!(request).status, "loading");
  const first = (await load(request))!; const second = (await load(request))!;
  assert.equal(first.source, second.source);
  assert.ok(first.source.startsWith("blob:"));
  assert.deepEqual(new Uint8Array(await (await fetch(first.source)).arrayBuffer()), new Uint8Array([1, 2, 3]));
  first.release?.(); second.release?.();
  const recreated = createAppServerMediaSourceLoader(runtime, ctx.blobResources, "ssh:demo");
  assert.equal(recreated.getSnapshot!({ ...request, documentId: "another-view" }).value?.source, first.source);
  const third = (await recreated(request))!;
  assert.equal(third.source, first.source); third.release?.();
  assert.equal(reads, 1);
  const pinned = (await load(request))!;
  await ctx.blobResources.invalidate((await import("../../apps/workbench-web/src/runtime/blob-files")).fileBlobResource(runtime, "ssh:demo", "/workspace/demo/preview.png"));
  assert.deepEqual(new Uint8Array(await (await fetch(pinned.source)).arrayBuffer()), new Uint8Array([1, 2, 3]), "legacy source lease remains valid during cache invalidation");
  pinned.release?.();
  await fiber.dispose();
  assert.equal(load.getSnapshot!(request).status, "unavailable");
  await assert.rejects(fetch(first.source));
});

test("historical user attachments use the same Host media boundary as Markdown", () => {
  const local = resolveConversationMediaSource(
    "/home/agentuser/.hermes/images/upload.png",
    "/home/agentuser",
    undefined,
    true,
  );
  assert.equal(local.directSource, null);
  assert.equal(local.loadThroughHost, true);
  assert.equal(local.decision.kind, "file");
  assert.equal(local.decision.target, "file:///home/agentuser/.hermes/images/upload.png");

  const remote = resolveConversationMediaSource("https://example.test/upload.png", null, undefined, true);
  assert.equal(remote.directSource, "https://example.test/upload.png");
  assert.equal(remote.loadThroughHost, false);
});

function reconnectingHost() {
  let snapshot = { phase: "reconnecting", connectionGeneration: 1, transport: { state: "connecting" }, error: null };
  const listeners = new Set<() => void>();
  const requests: import("@opencraft/appserver-protocol").AttachmentStageParams[] = [];
  const host = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    resources: { attachments: {
      capabilities: () => snapshot.phase === "ready" ? { version: 1, sources: ["client-bytes"], locations: ["host-file"], maxBytes: 1024 ** 3 } : null,
      async stage(request: import("@opencraft/appserver-protocol").AttachmentStageParams) {
        requests.push(request);
        return { ref: { id: request.clientAttachmentId, name: request.name, mimeType: request.mimeType, size: request.size, location: { kind: "host-file", path: "/staged/" + request.name } } };
      },
    } },
  } as unknown as Parameters<typeof resolveBrowserAttachmentForHost>[0];
  return { host, requests, listeners, transition(phase: string, generation = snapshot.connectionGeneration) {
    snapshot = { ...snapshot, phase, connectionGeneration: generation, transport: { state: phase === "ready" ? "open" : "closed" } };
    for (const listener of [...listeners]) listener();
  } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("pasted text waits for original Host readiness, stages exact bytes and unblocks its same draft", async () => {
  const { createComposerController } = await import("@opencraft/composer-core");
  const { createConversationKey } = await import("@opencraft/chat-core");
  const { attachmentPreviewSession } = await import("../../packages/composer-editor/src/attachment-preview-session");
  const fixture = reconnectingHost();
  const composer = createComposerController({ type: "existing-thread", key: createConversationKey("local", "text") }, { now: Date.now, createId: () => crypto.randomUUID() });
  const file = new File(["长段文本\n".repeat(1000)], "pasted-text.txt", { type: "text/plain" });
  const session = attachmentPreviewSession(composer);
  session.addFiles([file], (selected, attachment, signal) => resolveBrowserAttachmentForHost(fixture.host, selected, attachment, undefined, signal));
  const before = composer.getSnapshot().draft;
  await tick();
  assert.equal(fixture.requests.length, 0);
  assert.equal(composer.getSnapshot().draft.attachments[0]?.lifecycle, "uploading");
  assert.equal(composer.getSnapshot().canSubmit, false);
  fixture.transition("ready", 2);
  await tick();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0]?.clientAttachmentId, before.attachments[0]?.id);
  assert.deepEqual(fixture.requests[0]?.source, { kind: "client-bytes", dataBase64: Buffer.from(await file.arrayBuffer()).toString("base64") });
  assert.equal(composer.getSnapshot().draft.id, before.id);
  assert.equal(composer.getSnapshot().draft.attachments[0]?.lifecycle, "ready");
  assert.equal(composer.getSnapshot().canSubmit, true);
  assert.equal(fixture.listeners.size, 0);
  composer.dispose();
});

test("interrupted staging restarts with the same identity even if reconnect completes before rejection", async () => {
  for (const recoverFirst of [false, true]) {
    const fixture = reconnectingHost(); fixture.transition("ready");
    const stage = fixture.host.resources.attachments.stage;
    let reject!: (error: Error) => void;
    let attempts = 0;
    fixture.host.resources.attachments.stage = (...args) => ++attempts === 1 ? new Promise((_, fail) => { reject = fail; }) : stage(...args);
    const file = new File(["text"], "pasted-text.txt", { type: "text/plain" });
    const result = resolveBrowserAttachmentForHost(fixture.host, file, pending(file));
    await tick();
    fixture.transition("reconnecting");
    if (recoverFirst) fixture.transition("ready", 2);
    reject(new Error("connection closed"));
    await tick();
    if (!recoverFirst) { assert.equal(attempts, 1); fixture.transition("ready", 2); }
    assert.equal((await result).lifecycle, "ready");
    assert.equal(attempts, 2);
    assert.equal(fixture.requests[0]?.clientAttachmentId, "attachment-1");
    assert.equal(fixture.listeners.size, 0);
  }
});

test("stable Host refusal fails once and missing staging is not a reconnection", async () => {
  const fixture = reconnectingHost(); fixture.transition("ready");
  let attempts = 0;
  fixture.host.resources.attachments.stage = async () => { attempts++; throw new Error("permission denied"); };
  const file = new File(["text"], "pasted-text.txt", { type: "text/plain" });
  await assert.rejects(resolveBrowserAttachmentForHost(fixture.host, file, pending(file)), /permission denied/);
  assert.equal(attempts, 1);
  fixture.host.resources.attachments.capabilities = () => null;
  await assert.rejects(resolveBrowserAttachmentForHost(fixture.host, file, pending(file)), error => error instanceof BrowserAttachmentError && error.code === "HOST_FILE_STAGING_UNAVAILABLE");
  assert.equal(fixture.listeners.size, 0);
});

test("aborted or disposed waiting attachments never stage after readiness", async () => {
  for (const dispose of [false, true]) {
    const fixture = reconnectingHost(), controller = new AbortController();
    const file = new File(["text"], "pasted-text.txt", { type: "text/plain" });
    const result = resolveBrowserAttachmentForHost(fixture.host, file, pending(file), undefined, controller.signal);
    const failed = assert.rejects(result);
    if (dispose) fixture.transition("disposed"); else controller.abort();
    await failed;
    fixture.transition("ready", 2);
    await tick();
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.listeners.size, 0);
  }
});

test("offline inline images still resolve without acquiring a Host listener", async () => {
  const fixture = reconnectingHost();
  const file = new File(["png"], "photo.png", { type: "image/png" });
  assert.equal((await resolveBrowserAttachmentForHost(fixture.host, file, pending(file))).lifecycle, "ready");
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.requests.length, 0);
});


test("a disconnected chunk upload restarts at zero with fresh upload ID and original attachment identity", async () => {
  const fixture = reconnectingHost(); fixture.transition("ready");
  const cap = fixture.host.resources.attachments.capabilities()!;
  fixture.host.resources.attachments.capabilities = () => ({ ...cap, chunkBytes: 2 });
  const chunks: import("@opencraft/appserver-protocol").AttachmentUploadParams[] = [];
  const cancels: string[] = [];
  fixture.host.resources.attachments.uploadCancel = async id => { cancels.push(id); return { removed: true }; };
  fixture.host.resources.attachments.uploadChunk = async request => {
    chunks.push(request);
    if (chunks.length === 2) { fixture.transition("reconnecting"); throw new Error("connection closed"); }
    const receivedBytes = request.offset + Buffer.from(request.dataBase64, "base64").length;
    return { receivedBytes, ref: receivedBytes === request.size ? { id: request.clientAttachmentId, name: request.name, mimeType: request.mimeType, size: request.size, location: { kind: "host-file", path: "/staged/pasted-text.txt" } } : null };
  };
  const file = new File(["text"], "pasted-text.txt", { type: "text/plain" });
  const result = resolveBrowserAttachmentForHost(fixture.host, file, pending(file));
  await tick(); assert.equal(chunks.length, 2);
  fixture.transition("ready", 2);
  assert.equal((await result).lifecycle, "ready");
  assert.deepEqual(chunks.map(chunk => chunk.offset), [0, 2, 0, 2]);
  assert.notEqual(chunks[0]?.uploadId, chunks[2]?.uploadId);
  assert.deepEqual(cancels, [chunks[0]?.uploadId]);
  assert(chunks.every(chunk => chunk.clientAttachmentId === "attachment-1"));
  assert.equal(fixture.listeners.size, 0);
});

test("shared media never reuses a source across connection generations", async () => {
  let generation = 1, reads = 0;
  const runtime = { resources: { host: { getConnectionGeneration: () => generation },
    fileSystem: { async readFile() { reads++; return { dataBase64: "AQID" }; } } } } as unknown as AppServerWorkbenchRuntime;
  const ctx = new Context(), fiber = ctx.plugin(BlobResourceService); await fiber;
  const load = createAppServerMediaSourceLoader(runtime, ctx.blobResources, "host");
  const request = { source: "a.png", resolvedTarget: "file:///a.png", resourceKind: "file" as const, documentId: "image", hostId: "host", conversationId: "thread", cwd: "/" };
  try {
    const first = (await load(request))!; first.release?.();
    generation++;
    assert.equal(load.getSnapshot!(request).status, "loading");
    const second = (await load(request))!; assert.notEqual(second.source, first.source); second.release?.();
    assert.equal(reads, 2);
  } finally { await fiber.dispose(); }
});

test("ordinary media refresh bypasses old file bytes without withdrawing the displayed source", async () => {
  let reads = 0, fail = false;
  const runtime = { resources: { host: {}, fileSystem: { async readFile() {
    reads++; if (fail) throw new Error("offline"); return { dataBase64: reads === 1 ? "AQID" : "BAUG" };
  } } } } as unknown as AppServerWorkbenchRuntime;
  const ctx = new Context(), fiber = ctx.plugin(BlobResourceService); await fiber;
  const load = createAppServerMediaSourceLoader(runtime, ctx.blobResources, "host");
  const request = { source: "a.png", resolvedTarget: "file:///a.png", resourceKind: "file" as const, documentId: "image", hostId: "host", conversationId: "thread", cwd: "/" };
  const {fileBlobResource} = await import("../../apps/workbench-web/src/runtime/blob-files");
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const first = (await load(request))!;
    fail = true; await ctx.blobResources.refresh(fileBlobResource(runtime, "host", "/a.png")); await tick();
    assert.equal(load.getSnapshot!(request).value?.source, first.source);
    assert.equal(load.getSnapshot!(request).status, "ready"); assert.ok(load.getSnapshot!(request).error);
    fail = false; await ctx.blobResources.refresh(fileBlobResource(runtime, "host", "/a.png")); await tick();
    const fresh = load.getSnapshot!(request); assert.notEqual(fresh.value?.source, first.source);
    assert.deepEqual(new Uint8Array(await (await fetch(fresh.value!.source)).arrayBuffer()), new Uint8Array([4, 5, 6]));
    assert.equal(reads, 3); assert.equal(fresh.error, null);
    assert.deepEqual(new Uint8Array(await (await fetch(first.source)).arrayBuffer()), new Uint8Array([1, 2, 3])); first.release?.();
  } finally { await fiber.dispose(); }
});

test("replacement image preparation preserves old media on decode failure and releases aborted URLs", async () => {
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
  const decoding: { src: string; reject: (error: Error) => void }[] = [];
  class PreparingImage {
    src = "";
    decode() { return new Promise<void>((_resolve, reject) => { decoding.push(Object.assign(this, { reject })); }); }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: PreparingImage });
  const runtime = { resources: { host: {}, fileSystem: { async readFile() { return { dataBase64: "AQID" }; } } } } as unknown as AppServerWorkbenchRuntime;
  const ctx = new Context(), fiber = ctx.plugin(BlobResourceService); await fiber;
  const load = createAppServerMediaSourceLoader(runtime, ctx.blobResources, "host");
  const request = { source: "a.png", resolvedTarget: "file:///a.png", resourceKind: "file" as const, documentId: "image", hostId: "host", conversationId: "thread", cwd: "/" };
  const { fileBlobResource } = await import("../../apps/workbench-web/src/runtime/blob-files");
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const first = (await load(request))!;
    assert.equal(decoding.length, 0); // The cold path does not wait for replacement preparation.
    await ctx.blobResources.refresh(fileBlobResource(runtime, "host", "/a.png")); await tick();
    assert.equal(decoding.length, 1);
    assert.equal(load.getSnapshot!(request).value?.source, first.source);
    assert.equal(load.getSnapshot!(request).isFetching, true);
    const failedUrl = decoding[0]!.src;
    decoding[0]!.reject(new Error("invalid image")); await tick();
    assert.equal(load.getSnapshot!(request).value?.source, first.source);
    assert.match(String(load.getSnapshot!(request).error), /invalid image/);
    await assert.rejects(fetch(failedUrl));
    await ctx.blobResources.refresh(fileBlobResource(runtime, "host", "/a.png")); await tick();
    assert.equal(decoding.length, 2);
    const abortedUrl = decoding[1]!.src;
    first.release?.(); await tick();
    assert.equal(decoding[1]!.src, "");
    assert.equal(load.getSnapshot!(request).isFetching, false);
    assert.equal(load.getSnapshot!(request).value?.source, first.source);
    await assert.rejects(fetch(abortedUrl));
    decoding[1]!.reject(new Error("aborted decode")); await tick();
  } finally {
    await fiber.dispose();
    if (originalImage) Object.defineProperty(globalThis, "Image", originalImage);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});
