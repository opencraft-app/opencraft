import { openManagedDatabase } from "@opencraft/sqlite-node";
import { switchboardMigrations } from "../../plugins/im/src/store.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Switchboard } from "../../plugins/im/src/switchboard.js";
import { ImPlugin } from "../../plugins/im/src/server.js";
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const ref = { serverId: "server", threadId: "thread" };
async function fixture(t: test.TestContext, tool: boolean) {
  const root = await mkdtemp(join(tmpdir(), "im-reliability-proof-"));
  const board = await Switchboard.open(join(root, "im.sqlite"));
  let allowed = true,
    created = 0,
    submitted = 0;
  const beforeClose: (() => void)[] = [];
  const im = new ImPlugin(
    board,
    {
      human: (actorId) => ({ actorId, generation: 1, credentialId: null, expiresAt: Date.now() + 60000 }),
      authorize() {
        if (!allowed) throw Error("denied");
      },
      async create() {
        created++;
        return ref;
      },
      async validate() {},
      async submit() {
        submitted++;
        return "request";
      },
      async result() {
        return "answer";
      },
    },
    1024,
    tool,
  );
  await board.saveChannel(
    { id: "bot", ownerId: "owner", name: "test", provider: "slack", groupScope: "chat" },
    true,
    null,
  );
  const endpoint = { id: "bot", ownerId: "owner", senders: { external: "sender" }, groupScope: "chat" as const };
  let unregister = im.register(endpoint);
  t.after(async () => {
    for (const release of beforeClose) release();
    await im.close();
    await rm(root, { recursive: true, force: true });
  });
  const receive = () =>
    im.receive("bot", {
      id: "event",
      source: { chatId: "chat", chatType: "direct", senderId: "external" },
      text: "hello",
      replyAddress: { expiresAt: Date.now() + 60000, chat: "original" },
      async reply() {},
    });
  return {
    board,
    im,
    receive,
    created: () => created,
    submitted: () => submitted,
    defer: (f: () => void) => beforeClose.push(f),
    revoke: () => {
      allowed = false;
    },
    replace: () => {
      unregister();
      unregister = im.register(endpoint);
    },
  };
}
test("revocation while a real Worker commits claim must prevent late outbound effect", async (t) => {
  const f = await fixture(t, true);
  let sent = 0;
  f.im.setDelivery(async () => {
    sent++;
  });
  await f.receive();
  const message = (await f.board.messages("bot"))[0];
  const committed = gate(),
    resume = gate(),
    original = f.board.claimReply.bind(f.board);
  f.board.claimReply = async (...args) => {
    const result = await original(...args);
    committed.resolve();
    await resume.promise;
    return result;
  };
  const pending = f.im.reply(ref, { replyRef: message.reply_ref, text: "answer" }, new AbortController().signal);
  f.defer(() => resume.resolve());
  await committed.promise;
  f.revoke();
  resume.resolve();
  const result = await Promise.allSettled([pending]);
  assert.equal(sent, 0, "revoked Human cannot trigger delivery after the async durable claim");
  assert.equal(result[0].status, "rejected");
});
test("concurrent explicit resend of the same failed receipt cannot issue two physical sends", async (t) => {
  const f = await fixture(t, false);
  f.im.setDelivery(async () => {
    throw Error("unknown transport");
  });
  await assert.rejects(f.receive());
  const id = (await f.board.messages("bot"))[0].id;
  let sent = 0;
  f.im.setDelivery(async () => {
    sent++;
  });
  const both = gate(),
    read = f.board.message.bind(f.board);
  let snapshots = 0;
  f.board.message = async (id) => {
    const row = await read(id);
    if (snapshots < 2) {
      snapshots++;
      if (snapshots === 2) both.resolve();
      await both.promise;
    }
    return row;
  };
  f.defer(() => both.resolve());
  await Promise.allSettled([f.im.resend(id), f.im.resend(id)]);
  assert.equal(sent, 1, "same captured reply must be claimed once across concurrent admin operations");
});

for (const reason of ["cancelled", "replaced", "expired"] as const)
  test(`a ${reason} invocation cannot dispatch after the durable Worker claim`, async (t) => {
    const f = await fixture(t, true);
    let sent = 0;
    f.im.setDelivery(async () => {
      sent++;
    });
    await f.receive();
    const m = (await f.board.messages("bot"))[0]!,
      claimed = gate(),
      resume = gate(),
      controller = new AbortController();
    const original = f.board.claimReply.bind(f.board);
    f.board.claimReply = async (...args) => {
      const result = await original(...args);
      claimed.resolve();
      await resume.promise;
      return result;
    };
    f.defer(() => resume.resolve());
    const pending = f.im.reply(ref, { replyRef: m.reply_ref!, text: "answer" }, controller.signal);
    const settled = Promise.allSettled([pending]);
    await claimed.promise;
    if (reason === "cancelled") controller.abort();
    if (reason === "replaced") f.replace();
    if (reason === "expired") t.mock.method(Date, "now", () => Date.parse("2100-01-01T00:00:00Z"));
    resume.resolve();
    const result = await settled;
    assert.equal(result[0]!.status, "rejected");
    assert.equal(sent, 0);
    assert.equal(
      (await f.board.message(m.id))!.state,
      "reply_failed",
      "positive pre-dispatch rejection is not unknown delivery",
    );
  });

test("a positive send ACK is durable even if the caller loses authority while I/O is in flight", async (t) => {
  const f = await fixture(t, true),
    sent = gate(),
    resume = gate();
  let calls = 0;
  f.defer(() => resume.resolve());
  f.im.setDelivery(async () => {
    calls++;
    sent.resolve();
    await resume.promise;
  });
  await f.receive();
  const m = (await f.board.messages("bot"))[0]!;
  const pending = Promise.allSettled([
    f.im.reply(ref, { replyRef: m.reply_ref!, text: "answer" }, new AbortController().signal),
  ]);
  await sent.promise;
  f.revoke();
  resume.resolve();
  assert.equal((await pending)[0]!.status, "rejected", "retired caller receives no success disclosure");
  assert.equal(calls, 1);
  assert.equal((await f.board.message(m.id))!.state, "delivered", "authority loss cannot erase actual effect proof");
});

test("durable attempt nonces survive reopen and fence an old ACK after an explicit resend", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "im-reply-restart-")),
    path = join(root, "im.sqlite");
  let board = await Switchboard.open(path);
  t.after(async () => {
    await board.close();
    await rm(root, { recursive: true, force: true });
  });
  await board.accept({
    id: "message",
    channel_id: "bot",
    fingerprint: "test",
    actor_id: "sender",
    source: "{}",
    text: "hello",
    route_revision: 1,
    decision: null,
    reply_address: JSON.stringify({ chat: "original" }),
  });
  await board.patch("message", {
    state: "reply_pending",
    conversation_ref: JSON.stringify(ref),
    request_id: "request",
    reply_text: "answer",
  });
  const first = await board.claimReply("message", "answer", "final");
  assert.ok(first);
  assert.equal(await board.claimReply("message", "answer", "final"), null);
  await board.close();
  board = await Switchboard.open(path);
  await board.interruptUncertain();
  assert.equal((await board.message("message"))!.state, "reply_unknown");
  assert.deepEqual(await board.recoverable("bot"), [], "no automatic replay after interrupted delivery");
  assert.equal(await board.claimReply("message", "answer", "final"), null);
  assert.equal(await board.claimReply("message", "different", "resend"), null, "captured content is immutable");
  const second = await board.claimReply("message", "answer", "resend");
  assert.ok(second);
  assert.notEqual(second.token, first.token);
  assert.equal(
    await board.settleReply("message", first.token, "delivered", null),
    false,
    "late old ACK cannot clear the new attempt",
  );
  assert.equal((await board.message("message"))!.state, "reply_attempting");
  assert.equal(
    await board.prepareReply("message", "request", "late model result"),
    false,
    "late result cannot reset a claimed effect",
  );
  assert.equal(await board.settleReply("message", second.token, "delivered", null), true);
  await board.close();
  board = await Switchboard.open(path);
  assert.equal((await board.message("message"))!.state, "delivered");
  assert.equal(await board.claimReply("message", "answer", "resend"), null);
});

test("late positive proof may reconcile the same interrupted attempt, never mint another send", async (t) => {
  const f = await fixture(t, true);
  await f.receive();
  const m = (await f.board.messages("bot"))[0]!;
  const attempt = await f.board.claimReply(m.id, "answer");
  assert.ok(attempt);
  await f.board.interruptUncertain();
  assert.equal((await f.board.message(m.id))!.state, "reply_unknown");
  assert.equal(await f.board.settleReply(m.id, attempt.token, "delivered", null), true);
  assert.equal((await f.board.message(m.id))!.state, "delivered");
});

test("automatic final delivery rechecks revocation after claiming, just like explicit tool replies", async (t) => {
  const f = await fixture(t, false),
    claimed = gate(),
    resume = gate();
  let sent = 0;
  f.im.setDelivery(async () => {
    sent++;
  });
  f.defer(() => resume.resolve());
  const original = f.board.claimReply.bind(f.board);
  f.board.claimReply = async (...args) => {
    const claim = await original(...args);
    claimed.resolve();
    await resume.promise;
    return claim;
  };
  const pending = Promise.allSettled([f.receive()]);
  await claimed.promise;
  f.revoke();
  resume.resolve();
  assert.equal((await pending)[0]!.status, "rejected");
  assert.equal(sent, 0);
  assert.equal((await f.board.messages("bot"))[0]!.state, "reply_failed");
});

test("shutdown drains an already-dispatched explicit resend before closing its durable receipt owner", async (t) => {
  const f = await fixture(t, false);
  f.im.setDelivery(async () => {
    throw Error("unknown transport");
  });
  await assert.rejects(f.receive());
  const id = (await f.board.messages("bot"))[0]!.id,
    sent = gate(),
    resume = gate();
  f.defer(() => resume.resolve());
  f.im.setDelivery(async () => {
    sent.resolve();
    await resume.promise;
  });
  const resend = f.im.resend(id);
  await sent.promise;
  let closed = false;
  const closing = f.im.close().then(() => {
    closed = true;
  });
  assert.equal((await f.board.message(id))!.state, "reply_attempting");
  assert.equal(closed, false);
  resume.resolve();
  await resend;
  await closing;
  assert.equal(closed, true);
});

for (const stage of ["create", "submit"] as const)
  test(`inbound ${stage} rechecks original authority after asynchronous Worker storage`, async (t) => {
    const f = await fixture(t, true),
      committed = gate(),
      resume = gate();
    f.defer(() => resume.resolve());
    if (stage === "create") {
      const original = f.board.get.bind(f.board);
      f.board.get = async (...args) => {
        const result = await original(...args);
        committed.resolve();
        await resume.promise;
        return result;
      };
    } else {
      const original = f.board.patch.bind(f.board);
      f.board.patch = async (...args) => {
        const result = await original(...args);
        if (args[1].state === "accepted") {
          committed.resolve();
          await resume.promise;
        }
        return result;
      };
    }
    const pending = Promise.allSettled([f.receive()]);
    await committed.promise;
    f.revoke();
    resume.resolve();
    assert.equal((await pending)[0]!.status, "rejected");
    if (stage === "create") assert.equal(f.created(), 0);
    assert.equal(f.submitted(), 0);
  });

test("v3 interrupted sends upgrade without resetting their payload or manufacturing a delivered receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "im-v3-attempt-upgrade-")),
    path = join(root, "im.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = openManagedDatabase({ path, legacyPolicy: "reject", migrations: switchboardMigrations });
  old.database
    .prepare(
      "INSERT INTO im_messages(id,channel_id,fingerprint,actor_id,source,text,route_revision,state,reply_text,created_at,updated_at) VALUES('legacy','bot','original','sender','{}','hello',1,'reply_attempting','answer',1,1)",
    )
    .run();
  old.database.close();
  const board = await Switchboard.open(path);
  try {
    const upgraded = await board.message("legacy");
    assert.equal(board.outcome.appliedVersion, 4);
    assert.equal(upgraded!.reply_attempt, null);
    assert.equal(upgraded!.reply_text, "answer");
    assert.equal(upgraded!.fingerprint, "original");
    await board.interruptUncertain();
    assert.equal((await board.message("legacy"))!.state, "reply_unknown");
    assert.deepEqual(await board.recoverable("bot"), []);
    assert.equal(await board.claimReply("legacy", "answer", "final"), null);
  } finally {
    await board.close();
  }
});
