import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { BlobResourceService } from "@opencraft/blob-resources";
import { createChannelResources, type ChannelResourceTarget } from "../../plugins/im/src/channel-resources";
import { createChannelPictures } from "../../plugins/im/src/channel-pictures";
import { channelMediaKind } from "../../plugins/im/src/channel-media-kind";
import { channelGalleryItems, recordGalleryItems } from "../../plugins/im/src/channel-gallery-items";
import type { ChannelsClient } from "../../plugins/im/src/channel-client";
import type { ChannelMessage } from "@opencraft/appserver-protocol";
const target: ChannelResourceTarget = { group: "g", sequence: 2, kind: "record", path: "0.0" };
for (const shared of [false, true])
  test(`shared channel resources coalesce, survive recycling and isolate identities (${shared})`, async () => {
    const context = new Context();
    let blobs: BlobResourceService | undefined;
    if (shared) {
      await context.plugin(BlobResourceService, {});
      blobs = (context as any).blobResources;
    }
    const controller = new AbortController();
    let scope = "account-one",
      calls = 0;
    const client = {
      recordResource: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { name: "photo.png", blob: new Blob(["image"], { type: "image/png" }) };
      },
      attachment: async () => {
        calls++;
        return new Blob(["file"], { type: "image/png" });
      },
    } as unknown as ChannelsClient;
    const pictures = createChannelPictures({ client, blobs, signal: controller.signal, scope: () => scope }),
      resources = pictures.resources;
    const [a, b] = await Promise.all([
      resources.read(target, controller.signal),
      resources.read(target, controller.signal),
    ]);
    assert.equal(a, b);
    assert.equal(calls, 1);
    assert.equal((await resources.read(target, controller.signal)).blob, a.blob);
    const lease = pictures.resource(target);
    await new Promise<void>((resolve, reject) => {
      let stop = () => {};
      const check = () => {
        const s = pictures.getSnapshot(lease);
        if (s.status === "ready") {
          queueMicrotask(stop);
          resolve();
        } else if (s.status === "unavailable") {
          queueMicrotask(stop);
          reject(s.error);
        }
      };
      stop = pictures.subscribe(lease, check);
      check();
    });
    assert.equal(calls, 1, "decoded image and raw download share one provider load");
    const file = { group: "g", sequence: 3, kind: "attachment" as const };
    await resources.read(file, controller.signal);
    await resources.read({ ...file, mime: "image/png" }, controller.signal);
    assert.equal(calls, 2, "preview MIME does not duplicate file bytes");
    assert.notEqual(resources.resource({ ...target, group: "other" }).path, resources.resource(target).path);
    assert.notEqual(resources.resource({ ...target, path: "0.1" }).path, resources.resource(target).path);
    scope = "account-two";
    assert.equal(resources.getSnapshot(resources.resource(target)).status, "loading");
    await resources.read(target, controller.signal);
    assert.equal(calls, 3);
    controller.abort();
    assert.equal(resources.getSnapshot(resources.resource(target)).status, "unavailable");
    await context.dispose?.();
  });
test("cancel one subscriber without cancelling another; owner abort fences a late response", async () => {
  const owner = new AbortController(),
    one = new AbortController(),
    two = new AbortController();
  let finish!: (value: { name: string; blob: Blob }) => void,
    calls = 0;
  const resources = createChannelResources({
    scope: () => "scope",
    signal: owner.signal,
    client: {
      recordResource: () => {
        calls++;
        return new Promise((resolve) => (finish = resolve));
      },
    } as unknown as ChannelsClient,
  });
  const a = resources.read(target, one.signal),
    b = resources.read(target, two.signal);
  one.abort();
  await assert.rejects(a);
  assert.equal(calls, 1);
  finish({ name: "file", blob: new Blob(["ok"]) });
  assert.equal(await (await b).blob.text(), "ok");
  const later = { ...target, path: "0.1" },
    late = resources.read(later, two.signal);
  owner.abort();
  await assert.rejects(late);
  finish({ name: "late", blob: new Blob(["secret"]) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resources.getSnapshot(resources.resource(later)).status, "unavailable");
});
test("failed resource can be explicitly retried; no parallel queue implementation", async () => {
  const owner = new AbortController();
  let calls = 0;
  const resources = createChannelResources({
    scope: () => "scope",
    signal: owner.signal,
    client: {
      recordResource: async () => {
        if (++calls === 1) throw Error("temporary");
        return { name: "file", blob: new Blob(["ok"]) };
      },
    } as unknown as ChannelsClient,
  });
  await assert.rejects(resources.read(target, owner.signal));
  await resources.retry(target);
  assert.equal(await (await resources.read(target, owner.signal)).blob.text(), "ok");
  assert.equal(calls, 2);
  owner.abort();
});
test("gallery is limited to authorized page, raster images and stable per-resource identity", () => {
  const messages = [
    { sequence: 1, image: { state: "pending" } },
    { sequence: 2, image: { state: "ready" } },
    { sequence: 3, attachment: { name: "x.png", type: "image/png" } },
    { sequence: 4, attachment: { name: "evil.svg", type: "image/svg+xml" } },
  ] as ChannelMessage[];
  const items = channelGalleryItems("g", messages);
  assert.equal(items.length, 2);
  assert.equal(items[0].target.sequence, 2);
  assert.notEqual(items[0].id, channelGalleryItems("other", messages)[0].id);
  const nested: any = {
    version: 1,
    title: "nested",
    entries: [{ path: "0.1", sender: { id: "x", name: "X" }, parts: [{ kind: "image", resource: "0.1.0" }] }],
  };
  const record: any = {
    version: 1,
    title: "root",
    entries: [
      {
        path: "0",
        sender: { id: "x", name: "X" },
        parts: [
          { kind: "image", resource: "0.0" },
          { kind: "image", resource: "0.0" },
          { kind: "record", record: nested },
        ],
      },
    ],
  };
  assert.equal(recordGalleryItems("g", 5, record).length, 2);
  assert.notEqual(recordGalleryItems("g", 5, record)[0].id, recordGalleryItems("g", 6, record)[0].id);
});
test("media uses native player for candidates, never claims AMR/SILK or arbitrary data playable", () => {
  assert.equal(channelMediaKind("a.mp3"), "audio");
  assert.equal(channelMediaKind("video.webm"), "video");
  assert.equal(channelMediaKind("voice.amr"), null);
  assert.equal(channelMediaKind("a.silk", "audio/silk"), null);
  assert.equal(channelMediaKind("invoice.pdf"), null);
});
