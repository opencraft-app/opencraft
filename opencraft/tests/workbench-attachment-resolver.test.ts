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
} from "../apps/workbench-web/src/runtime/browser-attachment-resolver";
import {
  appServerMediaPath,
  createAppServerMediaSourceLoader,
  mediaMimeType,
} from "../apps/workbench-web/src/runtime/appserver-media-loader";
import { resolveConversationMediaSource } from "../apps/workbench-web/src/components/conversation/conversation-media-source";

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

test("browser images become host-independent Codex image URLs", async () => {
  const file = new File([new Uint8Array([1, 2, 3])], "paste.png", {
    type: "image/png",
  });
  const resolved = await resolveBrowserAttachment(file, pending(file));

  assert.equal(resolved.uri, "data:image/png;base64,AQID");
  assert.equal(resolved.lifecycle, "ready");
  assert.equal(resolved.error, null);
  assert.deepEqual(resolved.metadata, {
    source: "browser-inline",
    transport: "codex-image-url",
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

test("Markdown AppServer media reads share Blob cache and release their object URLs", async () => {
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

  const first = (await load(request))!; const second = (await load(request))!;
  assert.ok(first.source.startsWith("blob:"));
  assert.deepEqual(new Uint8Array(await (await fetch(first.source)).arrayBuffer()), new Uint8Array([1, 2, 3]));
  first.release?.(); second.release?.();
  assert.equal(reads, 1);
  await fiber.dispose();
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
