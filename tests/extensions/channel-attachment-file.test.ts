import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChannelAttachment, channelAttachmentFailure } from "../../plugins/im/src/channel-attachment-file";
import { ChannelsClient, type ChannelRpc } from "../../plugins/im/src/channel-client";
import { CHANNEL_IMAGE_LIMIT } from "@opencraft/appserver-protocol";

const jpeg = Uint8Array.from([255, 216, 255, 225, 0, 2, 255, 217]);
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
for (const [name, bytes, canonical] of [
  ["photo.JPG", jpeg, "image/jpeg"],
  ["photo.png", png, "image/png"],
] as const) {
  for (const type of ["", "application/octet-stream", "image/jpg", "image/pjpeg", "image/png", "image/jpeg"]) {
    test(`${name}: file bytes normalize ${type || "missing MIME"} without changing identity or contents`, async () => {
      const original = new File([bytes], name, { type, lastModified: 1234 });
      const prepared = await normalizeChannelAttachment(original);
      assert.equal(prepared.type, canonical);
      assert.equal(prepared.name, name);
      assert.equal(prepared.lastModified, 1234);
      assert.deepEqual(new Uint8Array(await prepared.arrayBuffer()), bytes);
      if (type === canonical) assert.equal(prepared, original);
      assert.equal(await normalizeChannelAttachment(prepared), prepared);
    });
  }
}

test("normalization reads only a bounded header; large native images remain ordinary attachments", async () => {
  class ObservedFile extends File {
    override slice(start?: number, end?: number, type?: string) {
      assert.equal(start, 0);
      assert.equal(end, 16);
      return super.slice(start, end, type);
    }
  }
  const bytes = new Uint8Array(CHANNEL_IMAGE_LIMIT + 1);
  bytes.set(jpeg);
  const prepared = await normalizeChannelAttachment(new ObservedFile([bytes], "camera.jpg", { type: "" }));
  assert.equal(prepared.type, "image/jpeg");
  assert.equal(prepared.size, bytes.length);
});

test("a filename or MIME label cannot turn arbitrary bytes into a JPEG or PNG", async () => {
  for (const [name, type] of [
    ["fake.jpg", ""],
    ["fake.PNG", "application/octet-stream"],
    ["fake.bin", "image/pjpeg"],
    ["empty.jpeg", "image/jpeg"],
  ]) {
    await assert.rejects(
      normalizeChannelAttachment(new File([name === "empty.jpeg" ? "" : "not an image"], name!, { type })),
      /channel_image_invalid/,
    );
  }
  const text = new File(["ordinary file"], "note.txt", { type: "text/plain" });
  assert.equal(await normalizeChannelAttachment(text), text);
});

test("aborted image preparation cannot publish a late normalized file", async () => {
  const owner = new AbortController();
  let release!: (bytes: ArrayBuffer) => void;
  class HeldFile extends File {
    override slice() {
      return {
        arrayBuffer: () =>
          new Promise<ArrayBuffer>((resolve) => {
            release = resolve;
          }),
      } as Blob;
    }
  }
  const result = normalizeChannelAttachment(new HeldFile([jpeg], "photo.jpg"), owner.signal);
  owner.abort();
  release(jpeg.buffer.slice(0));
  await assert.rejects(result, { name: "AbortError" });
  await assert.rejects(normalizeChannelAttachment(new File([jpeg], "photo.jpg"), owner.signal), { name: "AbortError" });
});

test("external rejection distinguishes oversized images, unsupported formats and ordinary files", () => {
  const refusal = Error("channel_files_unavailable"),
    unrelated = Error("channel_denied");
  const large = new File([new Uint8Array(CHANNEL_IMAGE_LIMIT + 1)], "camera.jpg", { type: "image/jpeg" });
  assert.match(String(channelAttachmentFailure(refusal, large)), /channel_image_too_large/);
  assert.match(
    String(channelAttachmentFailure(refusal, new File(["GIF89a"], "photo.gif", { type: "image/gif" }))),
    /channel_image_format_unavailable/,
  );
  for (const file of [new File(["text"], "note.txt"), new File([jpeg], "photo.jpg", { type: "image/jpeg" })]) {
    assert.equal(channelAttachmentFailure(refusal, file), refusal);
  }
  assert.equal(channelAttachmentFailure(unrelated, large), unrelated);
});

for (const chunks of [false, true])
  test(`transport normalizes ${chunks ? "chunked" : "legacy"} JPG sends, keeps bytes, caption and retry identity`, async () => {
    const calls: any[] = [],
      receipt = { sequence: 1, text: "", at: 1, author: "Me", status: "sending" };
    const rpc = {
      supportsAttachmentChunks: chunks,
      connect: async () => {},
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        return chunks ? { nextOffset: atob(params.base64).length, receipt } : { receipt };
      },
    } as unknown as ChannelRpc;
    const client = new ChannelsClient(fetch, rpc),
      original = new File([jpeg], "camera.JPG", { type: "image/jpg" });
    assert.equal(
      (
        await client.sendChannelAttachment(
          "group:test",
          "unchanged-id",
          original,
          new AbortController().signal,
          "caption",
        )
      ).receipt,
      receipt,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.type, "image/jpeg");
    assert.equal(calls[0].params.name, original.name);
    assert.equal(calls[0].params.clientMessageId, "unchanged-id");
    assert.equal(calls[0].params.text, "caption");
    assert.deepEqual(
      Uint8Array.from(atob(calls[0].params.base64), (ch) => ch.charCodeAt(0)),
      jpeg,
    );
  });

test("invalid image performs no RPC; definitive external refusal preserves original input and never replays sends", async () => {
  const calls: string[] = [];
  const rpc = {
    supportsAttachmentChunks: true,
    connect: async () => {},
    request: async (method: string) => {
      calls.push(method);
      if (method.endsWith("/delivery/get")) return { receipt: null };
      throw Error("channel_files_unavailable");
    },
  } as unknown as ChannelRpc;
  const client = new ChannelsClient(fetch, rpc),
    owner = new AbortController();
  await assert.rejects(
    client.sendChannelAttachment("group:test", "invalid", new File(["fake"], "fake.jpg"), owner.signal),
    /channel_image_invalid/,
  );
  assert.equal(calls.length, 0);
  const original = new File(["GIF89a"], "photo.gif", { type: "image/gif" });
  await assert.rejects(
    client.sendChannelAttachment("group:test", "original", original, owner.signal),
    /channel_image_format_unavailable/,
  );
  assert.deepEqual(calls, ["opencraft/channels/attachments/upload", "opencraft/channels/delivery/get"]);
  assert.equal(original.type, "image/gif");
  assert.equal(await original.text(), "GIF89a");
});
