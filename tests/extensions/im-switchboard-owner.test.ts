import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Switchboard } from "../../plugins/im/src/switchboard.js";
import { ImPlugin, type ImExecutionPort } from "../../plugins/im/src/server.js";

const channel = { id: "bot", provider: "wecom" as const, ownerId: "owner", name: "bot", groupScope: "chat" as const };

async function directory(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "im-switchboard-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "im.sqlite");
}

// docs/architecture/server/server-core-owner.md: routing reads configuration from
// memory; every write resolves only after the owner committed and returned it.
test("configuration writes resolve with the committed projection, and survive a reopen", async (t) => {
  const path = await directory(t);
  let board = await Switchboard.open(path);
  await board.saveChannel(channel, true, null);
  await board.linkSender("bot", "external", "sender");
  assert.equal(board.channel("bot")?.revision, 1);
  assert.deepEqual(board.senderLinks("bot"), { external: "sender" });
  await assert.rejects(board.saveChannel(channel, false, 7), /revision_conflict/);
  assert.equal(board.channel("bot")?.enabled, true, "a refused write leaves the projection unchanged");
  await assert.rejects(board.linkSender("bot", "external", "someone-else"), /identity_conflict/);
  await board.close();

  board = await Switchboard.open(path);
  try {
    assert.equal(board.hasChannel("bot"), true);
    assert.deepEqual(board.senderLinks("bot"), { external: "sender" });
    await board.removeChannel("bot");
    assert.equal(board.channel("bot"), null);
    assert.equal(board.hasChannel("bot"), true, "a deleted channel id stays reserved");
    assert.deepEqual(board.senderLinks("bot"), {});
  } finally {
    await board.close();
  }
});

test("an identity code is validated on the caller's thread and links only the challenge it validated", async (t) => {
  const board = await Switchboard.open(await directory(t));
  t.after(() => board.close());
  await board.saveChannel(channel, true, null);
  await board.challenge("hash-1", "bot", "sender");
  await assert.rejects(
    board.consumeChallenge("hash-1", "bot", "external", () => {
      throw new Error("actor disabled");
    }),
    /actor disabled/,
  );
  assert.deepEqual(board.senderLinks("bot"), {}, "a failed validation links nothing");
  const validated: string[] = [];
  assert.equal(await board.consumeChallenge("hash-1", "bot", "external", (actor) => validated.push(actor)), "sender");
  assert.deepEqual(validated, ["sender"]);
  assert.deepEqual(board.senderLinks("bot"), { external: "sender" });
  assert.equal(await board.consumeChallenge("hash-1", "bot", "other", () => {}), null, "a challenge is consumed once");
});

test("explicit-reply anchors follow writes; a message admitted before a restart is not admitted again", async (t) => {
  const path = await directory(t);
  const ref = { serverId: "server", threadId: "thread" };
  const submitted: string[] = [];
  const execution: ImExecutionPort = {
    human: (actorId) => ({ actorId, generation: 1, credentialId: null, expiresAt: Number.MAX_SAFE_INTEGER }),
    authorize() {},
    async create() {
      return ref;
    },
    async validate() {},
    async submit(_context, _ref, key) {
      submitted.push(key);
      return "request-" + submitted.length;
    },
    async result() {
      return new Promise<string>(() => {});
    },
  };
  const message = {
    id: "native-1",
    source: { chatId: "chat", chatType: "direct" as const, senderId: "external" },
    text: "hello",
    replyAddress: { expiresAt: Date.now() + 60_000 },
    async reply() {},
  };
  let board = await Switchboard.open(path);
  await board.saveChannel(channel, true, null);
  await board.linkSender("bot", "external", "sender");
  let im = new ImPlugin(board, execution, 1024, true);
  im.register({ ...channel, senders: {} });
  await im.receive("bot", message);
  assert.equal(submitted.length, 1);
  assert.equal(im.replyAvailable(ref), true, "the anchor reached the projection with the admission");
  await im.close();

  board = await Switchboard.open(path);
  im = new ImPlugin(board, execution, 1024, true);
  t.after(() => im.close());
  im.register({ ...channel, senders: {} });
  assert.equal(im.replyAvailable(ref), true, "anchors load with the snapshot");
  await im.receive("bot", message);
  assert.equal(submitted.length, 1, "the durable duplicate was recognised before routing");
  await assert.rejects(im.receive("bot", { ...message, text: "changed" }), /invalid_message/);
});
