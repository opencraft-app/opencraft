import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type { AppServerWorkbenchRuntime } from "../packages/workbench-runtime/src/appserver-runtime";

const require = createRequire(import.meta.url);
const { createNativeChatMediaSourceLoader } = require("../apps/workbench-expo/src/runtime/native-chat-media.ts") as typeof import("../apps/workbench-expo/src/runtime/native-chat-media");

function request(target: string, hostId = "host-1") {
  return {
    source: target, resolvedTarget: target, resourceKind: "file" as const,
    documentId: "message-1", conversationId: "thread-1", hostId, cwd: "/home/agentuser/workspace",
  };
}

test("native ChatUI loads Host raster bytes into a supported image source", async () => {
  const reads: string[] = [];
  const runtime = { resources: { host: {}, fileSystem: { readFile: async (path: string) => {
    reads.push(path);
    return { dataBase64: Buffer.from("PNG fixture").toString("base64") };
  } } } } as unknown as AppServerWorkbenchRuntime;
  const load = createNativeChatMediaSourceLoader(runtime, "host-1");
  assert.deepEqual(await load(request("file:///home/agentuser/workspace/chart.png")), {
    source: `data:image/png;base64,${Buffer.from("PNG fixture").toString("base64")}`,
  });
  assert.deepEqual(reads, ["/home/agentuser/workspace/chart.png"]);
});

test("native ChatUI refuses cross-Host, unsupported and oversized media", async () => {
  let reads = 0;
  const runtime = { resources: { host: {}, fileSystem: { readFile: async () => {
    reads++;
    return { dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") };
  } } } } as unknown as AppServerWorkbenchRuntime;
  const load = createNativeChatMediaSourceLoader(runtime, "host-1");
  assert.equal(await load(request("file:///private/other.png", "host-2")), null);
  assert.equal(await load(request("file:///private/vector.svg")), null);
  assert.equal(await load(request("file:///private/other.png")), null);
  assert.equal(reads, 1);
});

test("native ChatUI reuses short-lived Host images and invalidates them on reconnection", async () => {
  let reads = 0;
  let generation = 1;
  const runtime = { resources: {
    host: { getConnectionGeneration: () => generation },
    fileSystem: { readFile: async () => ({ dataBase64: Buffer.from(`image-${++reads}`).toString("base64") }) },
  } } as unknown as AppServerWorkbenchRuntime;
  const load = createNativeChatMediaSourceLoader(runtime, "host-1");
  const target = request("file:///home/agentuser/workspace/chart.png");
  const first = await load(target);
  assert.deepEqual(await load(target), first);
  assert.equal(reads, 1);
  generation++;
  assert.notDeepEqual(await load(target), first);
  assert.equal(reads, 2);
});

test("native ChatUI shares one Host read while cancelling only the departing consumer", async () => {
  let reads = 0;
  let finishRead: ((value: { dataBase64: string }) => void) | undefined;
  let hostSignal: AbortSignal | undefined;
  const runtime = { resources: {
    host: {},
    fileSystem: { readFile: (_path: string, signal: AbortSignal) => {
      reads++;
      hostSignal = signal;
      return new Promise<{ dataBase64: string }>(resolve => { finishRead = resolve; });
    } },
  } } as unknown as AppServerWorkbenchRuntime;
  const load = createNativeChatMediaSourceLoader(runtime, "host-1");
  const target = request("file:///home/agentuser/workspace/chart.png");
  const departing = new AbortController();
  const first = load({ ...target, signal: departing.signal });
  const second = load(target);
  departing.abort();
  assert.equal(await first, null);
  assert.equal(hostSignal?.aborted, false);
  finishRead?.({ dataBase64: Buffer.from("shared image").toString("base64") });
  assert.deepEqual(await second, { source: `data:image/png;base64,${Buffer.from("shared image").toString("base64")}` });
  assert.equal(reads, 1);
});

test("native ChatUI aborts an orphaned read and starts a fresh request", async () => {
  const hostSignals: AbortSignal[] = [];
  const finishes: Array<(value: { dataBase64: string }) => void> = [];
  const runtime = { resources: {
    host: {},
    fileSystem: { readFile: (_path: string, signal: AbortSignal) => {
      hostSignals.push(signal);
      return new Promise<{ dataBase64: string }>(resolve => { finishes.push(resolve); });
    } },
  } } as unknown as AppServerWorkbenchRuntime;
  const load = createNativeChatMediaSourceLoader(runtime, "host-1");
  const target = request("file:///home/agentuser/workspace/chart.png");
  const owner = new AbortController();
  const abandoned = load({ ...target, signal: owner.signal });
  owner.abort();
  assert.equal(await abandoned, null);
  assert.equal(hostSignals[0]?.aborted, true);
  const fresh = load(target);
  assert.equal(hostSignals.length, 2);
  finishes[0]?.({ dataBase64: Buffer.from("old").toString("base64") });
  finishes[1]?.({ dataBase64: Buffer.from("fresh").toString("base64") });
  assert.deepEqual(await fresh, { source: `data:image/png;base64,${Buffer.from("fresh").toString("base64")}` });
});
