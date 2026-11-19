import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";
import { ChannelsClient, type ChannelRpc } from "../../plugins/im/src/channel-client";
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "channel-files-")),
    storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  const human = (subject: string) =>
    actors.resolveHuman({ provider: "local", subject, displayName: subject, expiresAt: Date.now() + 60000 })!;
  const alice = human("alice"),
    bob = human("bob"),
    eve = human("eve");
  t.after(async () => {
    await service.close();
    actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = (c: any, m: string, p: Record<string, unknown> = {}) =>
    service.communicate(c, "opencraft/channels/" + m, p);
  const group = await call(alice, "group/create", {
    title: "files",
    memberActorIds: [bob.actorId],
    clientRequestId: "group",
  });
  const upload = (id = "file", channelId = group.id, bytes = Buffer.from("你好"), name = "note.txt", c = alice) =>
    call(c, "attachments/send", {
      channelId,
      clientMessageId: id,
      name,
      type: "text/plain",
      base64: bytes.toString("base64"),
    });
  return { directory, storage, actors, service, alice, bob, eve, call, group, upload };
}
test("file bytes, native history and receipt share one transaction and membership scope", async (t) => {
  const f = await fixture(t),
    first = await f.upload();
  assert.equal(first.receipt.status, "delivered");
  assert.deepEqual(first.receipt.attachment, { name: "note.txt", type: "text/plain", size: 6 });
  assert.equal((await f.upload()).receipt.messageId, first.receipt.messageId);
  await assert.rejects(f.upload("file", f.group.id, Buffer.from("other")), /idempotency/);
  const get = { channelId: f.group.id, sequence: first.receipt.sequence };
  assert.equal(Buffer.from((await f.call(f.bob, "attachments/get", get)).base64, "base64").toString(), "你好");
  await assert.rejects(f.call(f.eve, "attachments/get", get));
  await f.call(f.alice, "group/member/set", {
    channelId: f.group.id,
    actorId: f.bob.actorId,
    present: false,
    clientRequestId: "remove",
  });
  await assert.rejects(f.call(f.bob, "attachments/get", get));
  assert.equal((await f.call(f.alice, "messages/list", { channelId: f.group.id })).messages.length, 1);
});
test("invalid files do not create messages or consume request IDs", async (t) => {
  const f = await fixture(t);
  for (const name of ["../secret", "bad\nname", ".", "x".repeat(161)])
    await assert.rejects(f.upload("invalid", f.group.id, Buffer.from("x"), name), /invalid_input/);
  await assert.rejects(f.upload("big", f.group.id, Buffer.alloc(20 * 1024 * 1024 + 1)), /invalid_input/);
  await assert.rejects(
    f.call(f.alice, "attachments/send", {
      channelId: f.group.id,
      clientMessageId: "base64",
      name: "x",
      type: "text/plain",
      base64: "a===",
    }),
    /invalid_input/,
  );
  assert.equal((await f.call(f.alice, "messages/list", { channelId: f.group.id })).messages.length, 0);
  await f.upload("invalid");
});
test("assistant reads only its owners immutable attachment through bounded chunks", async (t) => {
  const f = await fixture(t);
  await f.service.personalAssistant(f.alice, "opencraft/personal-assistant/claim");
  const { channel } = await f.service.personalAssistant(f.alice, "opencraft/personal-assistant/open");
  const provision = await f.service.provisionPersonalAssistant(f.alice),
    bot = f.actors.authenticateSession(provision.credential.token)!;
  const bytes = Buffer.alloc(150000, 65),
    { receipt } = await f.upload("large", channel.id, bytes);
  const rows = await f.service.communicate(bot, "personal-assistant/own-messages", { after: 0 });
  assert.equal(rows[0].attachment.size, bytes.length);
  assert.equal(rows[0].attachment.bytes, undefined);
  let offset: number | null = 0;
  const chunks: Buffer[] = [];
  do {
    const file = await f.service.communicate(bot, "personal-assistant/attachment", {
      messageId: receipt.messageId,
      offset,
    });
    assert.ok(file.base64.length < 100000);
    chunks.push(Buffer.from(file.base64, "base64"));
    offset = file.next;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const other = await f.upload("not-owned");
  await assert.rejects(
    f.service.communicate(bot, "personal-assistant/attachment", { messageId: other.receipt.messageId }),
  );
  await f.service.personalAssistant(f.alice, "opencraft/personal-assistant/revoke");
  await assert.rejects(f.service.communicate(bot, "personal-assistant/attachment", { messageId: receipt.messageId }));
});
test("external groups never claim unsupported file forwarding succeeded", async (t) => {
  const f = await fixture(t);
  await f.service.synchronizeChannels({
    method: "configure",
    params: { incarnation: "test", bindings: [{ source: "external", channelId: f.group.id }], images: true },
  });
  await assert.rejects(f.upload(), /channel_files_unavailable/);
  assert.equal((await f.call(f.alice, "messages/list", { channelId: f.group.id })).messages.length, 0);
});

test("browser JPEG aliases and missing MIME reach the native external-image outbox, not file refusal", async (t) => {
  const f = await fixture(t);
  await f.service.synchronizeChannels({
    method: "configure",
    params: { incarnation: "test", bindings: [{ source: "external", channelId: f.group.id }], images: true },
  });
  const rpc = {
    supportsAttachmentChunks: true,
    connect: async () => {},
    request: (method: string, params: Record<string, unknown>) => f.service.communicate(f.alice, method, params),
  } as unknown as ChannelRpc;
  const client = new ChannelsClient(fetch, rpc),
    signal = new AbortController().signal;
  for (const [i, type] of ["image/jpg", "image/pjpeg", "", "application/octet-stream", "image/jpeg"].entries()) {
    const bytes = new Uint8Array(70000);
    bytes.set([255, 216, 255, 225]);
    const file = new File([bytes], "camera-" + i + ".JPG", { type });
    const { receipt } = await client.sendChannelAttachment(f.group.id, "jpeg-" + i, file, signal);
    assert.equal(receipt.status, "sending");
    assert.ok(receipt.image);
    assert.equal(receipt.attachment, undefined);
    const fetched = await f.call(f.alice, "attachments/get", { channelId: f.group.id, sequence: receipt.sequence });
    assert.equal(fetched.type, "image/jpeg");
    assert.deepEqual(Buffer.from(fetched.base64, "base64"), Buffer.from(bytes));
    assert.equal(
      (await client.sendChannelAttachment(f.group.id, "jpeg-" + i, file, signal)).receipt.messageId,
      receipt.messageId,
    );
  }
  assert.equal((await f.call(f.alice, "messages/list", { channelId: f.group.id })).messages.length, 5);
  const large = new Uint8Array(2 * 1024 * 1024 + 1);
  large.set([255, 216, 255, 225]);
  await assert.rejects(
    client.sendChannelAttachment(
      f.group.id,
      "oversized",
      new File([large], "large.jpg", { type: "image/jpg" }),
      signal,
    ),
    /channel_image_too_large/,
  );
  assert.equal((await f.call(f.alice, "messages/list", { channelId: f.group.id })).messages.length, 5);
});

test("chunk upload retries exact offsets and final acknowledgement without duplicate messages", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.alloc(150000, 65);
  const params = {
    channelId: f.group.id,
    clientMessageId: "chunked",
    name: "file.bin",
    type: "application/octet-stream",
    total: bytes.length,
  };
  const send = (offset: number, data = bytes.subarray(offset, offset + 65536)) =>
    f.call(f.alice, "attachments/upload", { ...params, offset, base64: data.toString("base64") });
  assert.deepEqual(await send(0), { nextOffset: 65536 });
  assert.deepEqual(await send(0), { nextOffset: 65536 });
  await assert.rejects(send(0, Buffer.alloc(65536, 66)), /idempotency_conflict/);
  assert.deepEqual(await send(65536), { nextOffset: 131072 });
  const final = await send(131072),
    replayed = await send(131072);
  assert.equal(final.receipt.messageId, replayed.receipt.messageId);
  const file = await f.call(f.bob, "attachments/get", { channelId: f.group.id, sequence: final.receipt.sequence });
  assert.deepEqual(Buffer.from(file.base64, "base64"), bytes);
  assert.equal((await f.call(f.alice, "messages/list", { channelId: f.group.id })).messages.length, 1);
});
test("chunk admission checks current membership on every chunk, bounds input and rejects unknown offsets", async (t) => {
  const f = await fixture(t),
    p = {
      channelId: f.group.id,
      clientMessageId: "held",
      name: "x",
      type: "application/octet-stream",
      total: 100000,
      offset: 0,
      base64: Buffer.alloc(65536).toString("base64"),
    };
  await assert.rejects(f.call(f.eve, "attachments/upload", p), /channel_denied/);
  await assert.rejects(
    f.call(f.bob, "attachments/upload", { ...p, offset: 65536, base64: Buffer.alloc(100).toString("base64") }),
    /channel_upload_expired/,
  );
  await assert.rejects(f.call(f.bob, "attachments/upload", { ...p, total: 21 * 1024 * 1024 }), /invalid_input/);
  await f.call(f.bob, "attachments/upload", p);
  await f.call(f.alice, "group/member/set", {
    channelId: f.group.id,
    actorId: f.bob.actorId,
    present: false,
    clientRequestId: "revoke-upload",
  });
  await assert.rejects(
    f.call(f.bob, "attachments/upload", { ...p, offset: 65536, base64: Buffer.alloc(34464).toString("base64") }),
    /channel_denied/,
  );
  assert.equal((await f.call(f.alice, "messages/list", { channelId: f.group.id })).messages.length, 0);
});
test("completed upload buffers are evictable, so repeated uploads do not exhaust per-actor capacity", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const result = await f.call(f.alice, "attachments/upload", {
      channelId: f.group.id,
      clientMessageId: "small-" + i,
      name: "x",
      type: "application/octet-stream",
      total: 1,
      offset: 0,
      base64: "eA==",
    });
    assert.equal(result.receipt.status, "delivered");
  }
  assert.equal((await f.call(f.alice, "messages/list", { channelId: f.group.id })).messages.length, 10);
});

test("download chunks are bounded and recheck membership instead of returning whole attachment bytes", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.alloc(150000, 23),
    { receipt } = await f.upload("download", f.group.id, bytes);
  const parts: Buffer[] = [];
  let offset = 0;
  do {
    const part = await f.call(f.bob, "attachments/read", { channelId: f.group.id, sequence: receipt.sequence, offset });
    assert.equal(part.size, bytes.length);
    const chunk = Buffer.from(part.base64, "base64");
    assert.ok(chunk.length <= 65536);
    parts.push(chunk);
    offset = part.nextOffset;
  } while (offset < bytes.length);
  assert.deepEqual(Buffer.concat(parts), bytes);
  await f.call(f.alice, "group/member/set", {
    channelId: f.group.id,
    actorId: f.bob.actorId,
    present: false,
    clientRequestId: "remove-downloader",
  });
  await assert.rejects(
    f.call(f.bob, "attachments/read", { channelId: f.group.id, sequence: receipt.sequence, offset: 0 }),
    /channel_denied/,
  );
});
