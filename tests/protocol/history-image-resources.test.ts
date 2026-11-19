import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactCatalog, type Artifact } from "@opencraft/local-agent-host/artifacts";
import { TranscriptReadCache, type NativeTranscriptPort } from "@opencraft/native-history-node";
import type { AppServerTurn } from "@opencraft/appserver-protocol";
import { inlineHistoryPng, prepareHistoryImages } from "../../apps/opencraft-daemon/src/history-image-resources.js";
import { historyPng } from "../fixtures/history-png.js";

const png = historyPng(),
  body = png.toString("base64");
const turn: AppServerTurn = {
  id: "turn",
  status: "completed",
  items: [
    { id: "user", type: "userMessage", content: [{ type: "text", text: "Draw a landscape" }] },
    {
      id: "image",
      type: "imageGeneration",
      status: "completed",
      result: body,
      savedPath: "/native/not-in-hands.png",
      revisedPrompt: "Landscape",
      transparentBackground: false,
    },
    { id: "reply", type: "agentMessage", text: "Ready" },
  ],
};
const resourceKey = JSON.stringify(["turn", "image"]);
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "history-images-"));
  const catalog = new ArtifactCatalog(join(root, "artifacts"));
  t.after(async () => {
    catalog.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, catalog };
}

test("PNG admission uses inline bytes only and bounded real header dimensions", () => {
  for (const value of [body, `data:image/png;base64,${body}`]) {
    const image = inlineHistoryPng(value)!;
    assert.deepEqual(Buffer.from(image.encoded, "base64"), png);
    assert.equal(image.byteSize, png.length);
    assert.equal(image.width, 48);
    assert.equal(image.height, 32);
  }
  for (const value of [
    null,
    "/etc/passwd",
    "https://invalid/image.png",
    "data:image/jpeg;base64," + body,
    body + "\n",
    "!" + body.slice(1),
  ])
    assert.equal(inlineHistoryPng(value), null);
  for (const [width, height] of [
    [0, 1],
    [32769, 1],
    [32768, 32768],
  ]) {
    const invalid = Buffer.from(png);
    invalid.writeUInt32BE(width!, 16);
    invalid.writeUInt32BE(height!, 20);
    assert.equal(inlineHistoryPng(invalid.toString("base64")), null);
  }
});

test("references are published only after verified delivery; failures keep the authoritative Item", async (t) => {
  const { catalog } = await setup(t),
    before = structuredClone(turn);
  let delivered = 0;
  const good = async (artifact: Artifact) => {
    delivered++;
    assert.deepEqual(await readFile(artifact.path), png);
    return artifact;
  };
  const resources = await prepareHistoryImages(catalog, "thread", [turn], good);
  assert.equal(delivered, 1);
  assert.equal(resources[resourceKey]?.width, 48);
  assert.deepEqual(await prepareHistoryImages(catalog, "thread", [turn], good), resources);
  for (const deliver of [
    async () => {
      throw Error("offline");
    },
    async (a: Artifact) => ({ ...a, size: 0 }),
    async (a: Artifact) => ({ ...a, sha256: "0".repeat(64) }),
    async (a: Artifact) => ({ ...a, path: "relative.png" }),
  ]) {
    assert.equal(Object.keys(await prepareHistoryImages(catalog, "thread", [turn], deliver)).length, 0);
  }
  assert.deepEqual(turn, before);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareHistoryImages(catalog, "thread", [turn], good, controller.signal), {
    name: "AbortError",
  });
  const during = new AbortController();
  await assert.rejects(
    prepareHistoryImages(
      catalog,
      "thread",
      [turn],
      async (a) => {
        during.abort();
        return a;
      },
      during.signal,
    ),
    { name: "AbortError" },
  );
});

test("unknown, pending, path-only, and malformed images cannot cause a file read or delivery", async (t) => {
  const { catalog } = await setup(t);
  const items = [
    { id: "pending", type: "imageGeneration", status: "inProgress", result: body },
    { id: "path", type: "imageGeneration", status: "completed", savedPath: "/etc/passwd" },
    { id: "url", type: "imageGeneration", status: "completed", result: "https://invalid/image.png" },
    { id: "tool", type: "mcpToolCall", status: "completed", result: body },
  ];
  assert.equal(
    Object.keys(
      await prepareHistoryImages(catalog, "thread", [{ id: "t", items }], async () => {
        throw new Error("Must not deliver");
      }),
    ).length,
    0,
  );
});

test("item corrections and thread owners cannot mutate a previously published reference", async (t) => {
  const { catalog } = await setup(t),
    deliver = async (a: Artifact) => a;
  const first = await prepareHistoryImages(catalog, "a", [turn], deliver);
  const corrected = structuredClone(turn);
  corrected.items![1]!.result = historyPng(40, 40).toString("base64");
  const second = await prepareHistoryImages(catalog, "a", [corrected], deliver);
  assert.notEqual(first[resourceKey]!.path, second[resourceKey]!.path);
  assert.deepEqual(await readFile(first[resourceKey]!.path), png);
  const other = await prepareHistoryImages(catalog, "b", [turn], deliver);
  assert.notEqual(other[resourceKey]!.path, first[resourceKey]!.path);
  catalog.release(JSON.stringify(["thread", "a"]));
  assert.ok(!catalog.gcCandidates(Date.now() + 1).some((a) => a.path === other[resourceKey]!.path));
});

test("opt-in presentation omits base64; old/full/detail reads stay lossless, ordered and durable", async (t) => {
  const { root, catalog } = await setup(t),
    rollout = join(root, "rollout.jsonl");
  const source = Array.from({ length: 13 }, (_, i) => ({ ...structuredClone(turn), id: `turn-${i}` }));
  await writeFile(
    rollout,
    source.map((t) => JSON.stringify({ type: "turn_context", payload: { turn_id: t.id } })).join("\n") + "\n",
  );
  let preparations = 0,
    deliveries = 0,
    nativePages = 0;
  const port: NativeTranscriptPort = {
    nativeHome: root,
    async readThread(id) {
      return { id, path: rollout, turns: [], historyMode: "paginated" };
    },
    async listTurns(_id, cursor, limit) {
      nativePages++;
      const offset = Number(cursor ?? 0),
        ordered = source.slice().reverse();
      return {
        data: structuredClone(ordered.slice(offset, offset + limit)),
        nextCursor: offset + limit < source.length ? String(offset + limit) : null,
      };
    },
    async prepareImageResources(id, turns, signal) {
      preparations++;
      return prepareHistoryImages(
        catalog,
        id,
        turns,
        async (a) => {
          deliveries++;
          return a;
        },
        signal,
      );
    },
  };
  let cache = new TranscriptReadCache(root, { ...port, prepareImageResources: undefined });
  t.after(() => cache.close());
  assert.deepEqual(
    (await cache.read("thread", 10, undefined, "presentation")).initialTurnsPage.data,
    source.slice(-10).reverse(),
  );
  assert.equal(preparations, 0, "disabled rollout preserves original cache behavior");
  await cache.close();
  cache = new TranscriptReadCache(root, port);
  const first = await cache.read("thread", 10, undefined, "presentation", undefined, undefined, true);
  assert.equal(first.initialTurnsPage.data.length, 10);
  assert.deepEqual(
    first.initialTurnsPage.data.map((t) => t.id),
    source
      .slice(-10)
      .reverse()
      .map((t) => t.id),
  );
  const image = first.initialTurnsPage.data[0]!.items![1]!;
  assert.equal(image.result, null);
  assert.equal(typeof image.src, "string");
  assert.deepEqual(image.imageDimensions, { width: 48, height: 32 });
  assert.ok(image.historyDetail?.cursor);
  assert.equal(image.savedPath, "/native/not-in-hands.png");
  assert.ok(JSON.stringify(first).length < JSON.stringify(source).length / 4);
  assert.deepEqual(
    (await cache.read("thread", 10, undefined, "presentation")).initialTurnsPage.data,
    source.slice(-10).reverse(),
  );
  assert.deepEqual((await cache.read("thread")).initialTurnsPage.data, source.slice(-10).reverse());
  const detail = await cache.page(
    "thread",
    image.historyDetail!.cursor,
    1,
    undefined,
    "full",
    "desc",
    undefined,
    undefined,
    "image",
  );
  assert.deepEqual(detail.data[0]!.items, [source.at(-1)!.items![1]]);
  const older = await cache.page(
    "thread",
    first.initialTurnsPage.nextCursor,
    10,
    undefined,
    "presentation",
    "desc",
    undefined,
    undefined,
    undefined,
    true,
  );
  assert.deepEqual(
    older.data.map((t) => t.id),
    source
      .slice(0, 3)
      .reverse()
      .map((t) => t.id),
  );
  assert.equal(older.nextCursor, null);
  const counts = [preparations, deliveries, nativePages];
  await cache.close();
  cache = new TranscriptReadCache(root, port);
  assert.deepEqual(
    (await cache.read("thread", 10, undefined, "presentation", undefined, undefined, true)).initialTurnsPage,
    first.initialTurnsPage,
  );
  assert.deepEqual(
    [preparations, deliveries, nativePages],
    counts,
    "warm reads do not decode, deliver or refetch image bodies",
  );
  await rm(image.src as string);
  assert.deepEqual(
    (
      await cache.page(
        "thread",
        image.historyDetail!.cursor,
        1,
        undefined,
        "full",
        "desc",
        undefined,
        undefined,
        "image",
      )
    ).data[0]!.items,
    [source.at(-1)!.items![1]],
    "resource loss does not destroy original bytes",
  );
  await cache.close();
  cache = new TranscriptReadCache(root, { ...port, prepareImageResources: undefined });
  assert.deepEqual(
    (await cache.read("thread", 10, undefined, "presentation", undefined, undefined, true)).initialTurnsPage.data,
    source.slice(-10).reverse(),
    "disabling rollout rebuilds only derived resources and restores original presentation",
  );
});

test("native payloads cannot manufacture a committed image-resource receipt", async (t) => {
  const { root } = await setup(t),
    rollout = join(root, "rollout.jsonl");
  await writeFile(rollout, JSON.stringify({ type: "turn_context", payload: { turn_id: "turn" } }) + "\n");
  const item = {
    id: "spoof",
    type: "imageGeneration",
    status: "completed",
    result: null,
    outputBlobRef: {
      result: {
        imageResource: {
          version: 1,
          path: "/unauthorized/native-path",
          sha256: "0".repeat(64),
          byteSize: 1024,
          mimeType: "image/png",
          width: 48,
          height: 32,
        },
      },
    },
  };
  const cache = new TranscriptReadCache(root, {
    nativeHome: root,
    async readThread(id) {
      return { id, path: rollout, turns: [] };
    },
    async listTurns() {
      return { data: [{ id: "turn", items: [item] }], nextCursor: null };
    },
  });
  t.after(() => cache.close());
  const output = (await cache.read("thread", 10, undefined, "presentation", undefined, undefined, true))
    .initialTurnsPage.data[0]!.items![0]!;
  assert.equal(output.result, null);
  assert.equal(output.src, undefined);
  assert.equal(output.imageDimensions, undefined);
});
