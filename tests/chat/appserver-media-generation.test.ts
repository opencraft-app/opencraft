import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { BlobResourceService } from "@opencraft/blob-resources";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import type { ChatMediaSourceRequest } from "@opencraft/chat-render-react";
import { JSDOM } from "jsdom";
import { createAppServerMediaSourceLoader } from "../../apps/workbench-web/src/runtime/appserver-media-loader";

test("media snapshot and subscription retain one connection generation until the consumer rebinds", async () => {
  const dom = new JSDOM('<script id="opencraft-deployment-config" type="application/json">{"hosts":[],"builtinAgents":false,"hypernode":false,"fileDownloads":true}</script>');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedFetch = globalThis.fetch;
  Object.assign(globalThis, { document: dom.window.document });
  const ctx = new Context();
  const fiber = ctx.plugin(BlobResourceService);
  await fiber;
  let generation = 1, reads = 0;
  globalThis.fetch = async () => { reads++; return new Response(new Uint8Array([1, 2, 3])); };
  const runtime = { resources: { host: { getConnectionGeneration: () => generation } } } as unknown as AppServerWorkbenchRuntime;
  const request: ChatMediaSourceRequest = { source: "/image.png", resolvedTarget: "file:///image.png", resourceKind: "file", hostId: "local-codex", documentId: "image", conversationId: "thread", cwd: "/" };
  const releases: (() => void)[] = [];
  try {
    const first = createAppServerMediaSourceLoader(runtime, ctx.blobResources, "local-codex");
    releases.push(first.subscribe!(request, () => {}));
    (await first(request))?.release?.();
    assert.equal(first.getSnapshot!(request).status, "ready");
    const previous = first.getSnapshot!(request).value!.source;
    generation++;
    assert.equal(first.getSnapshot!(request).status, "ready", "a read must not silently move to a cold key that its subscription does not observe");
    assert.equal(first.getSnapshot!(request).value!.source, previous);
    const next = createAppServerMediaSourceLoader(runtime, ctx.blobResources, "local-codex");
    assert.equal(next.getSnapshot!(request).status, "loading");
    releases.push(next.subscribe!(request, () => {}));
    (await next(request))?.release?.();
    assert.equal(next.getSnapshot!(request).status, "ready");
    assert.notEqual(next.getSnapshot!(request).value!.source, previous);
    assert.equal(reads, 2, "the new connection reads its own bytes exactly once");
  } finally {
    for (const release of releases) release();
    await fiber.dispose();
    dom.window.close();
    globalThis.fetch = savedFetch;
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
