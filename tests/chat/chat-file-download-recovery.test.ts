import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { fileDownloadSource, FileBlobNetworkError, FileBlobReadError, loadFileBlob } from "../../apps/workbench-web/src/runtime/blob-files";

test("same-server download images retain file authority and bounded transient recovery", async () => {
  const dom = new JSDOM('<script id="opencraft-deployment-config" type="application/json">{"hosts":[],"builtinAgents":false,"hypernode":false,"fileDownloads":true}</script>', { url: "https://chat.example.test/" });
  const saved = Object.fromEntries(["window", "document", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  let rpcReads = 0;
  const runtime = { resources: { fileSystem: { readFile: async () => { rpcReads++; throw new Error("HTTP failures must not fall back to RPC"); } } } } as unknown as AppServerWorkbenchRuntime;
  const path = "/workspace/设计 #100%.png";
  const source = "https://chat.example.test/__opencraft_files?" + new URLSearchParams({ hostId: "opencraft-server", path });
  try {
    const target = fileDownloadSource(source, "local-codex")!;
    assert.equal(decodeURIComponent(new URL(target).pathname), path);
    assert.equal(fileDownloadSource(source.replace("chat.example.test", "other.example.test"), "local-codex"), null);
    assert.equal(fileDownloadSource(source, "ssh:remote"), null);
    assert.equal(fileDownloadSource(source + "&hostId=local-codex", "local-codex"), null);
    assert.equal(fileDownloadSource(source.replace("/__opencraft_files", "/servers/other/__opencraft_files"), "local-codex"), null);
    let calls = 0;
    const attempts: number[] = [];
    globalThis.fetch = async () => ++calls < 3 ? new Response(null, { status: 503 }) : new Response("png bytes");
    const blob = await loadFileBlob(runtime, "local-codex", path, new AbortController().signal, n => attempts.push(n));
    assert.equal(await blob.text(), "png bytes");
    assert.deepEqual(attempts, [1, 2, 3]);
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 403 }); };
    await assert.rejects(loadFileBlob(runtime, "local-codex", path, new AbortController().signal), error => error instanceof FileBlobReadError && error.httpStatus === 403 && error.attempts === 1);
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError("network interrupted"); };
    await assert.rejects(loadFileBlob(runtime, "local-codex", path, new AbortController().signal), error => error instanceof FileBlobNetworkError && error.phase === "fetch" && error.attempts === 5);
    assert.equal(calls, 5);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1 ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("body interrupted")); } })) : new Response("recovered");
    };
    assert.equal(await (await loadFileBlob(runtime, "local-codex", path, new AbortController().signal)).text(), "recovered");
    assert.equal(calls, 2);
    calls = 0;
    const backoff = new AbortController();
    globalThis.fetch = async () => { calls++; setTimeout(() => backoff.abort(), 25); return new Response(null, { status: 503 }); };
    await assert.rejects(loadFileBlob(runtime, "local-codex", path, backoff.signal), error => error === backoff.signal.reason);
    assert.equal(calls, 1, "cancellation during backoff must not issue another read");
    calls = 0;
    const cancel = new AbortController();
    globalThis.fetch = async () => { calls++; queueMicrotask(() => cancel.abort()); throw new TypeError("interrupted"); };
    await assert.rejects(loadFileBlob(runtime, "local-codex", path, cancel.signal), error => error === cancel.signal.reason);
    assert.equal(calls, 1);
    assert.equal(rpcReads, 0);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
