import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";
import { parsePrincipal } from "@opencraft/identity-core";
import {
  channelComposerPayload,
  ChannelMentionText,
} from "../../plugins/im/src/channel-mentions";
import {
  composerDocumentToPlainText,
  type ComposerDocument,
} from "@opencraft/composer-core";
import { renderToStaticMarkup } from "react-dom/server";
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "native-mention-")),
    storage = await openServerDatabase(dir),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  const human = (subject: string) =>
    actors.resolveHuman(
      parsePrincipal({
        provider: "local",
        subject,
        displayName: subject,
        expiresAt: Date.now() + 60000,
      })!,
    )!;
  const alice = human("Alice"),
    bob = human("Bob"),
    outsider = human("Outsider"),
    call = (c: typeof alice, m: string, p: any = {}) =>
      service.communicate(c, "opencraft/channels/" + m, p);
  const group = await call(alice, "group/create", {
    title: "Room",
    memberActorIds: [bob.actorId],
    clientRequestId: "group",
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await service.close();
    actors.close();
    await storage.close();
  };
  t.after(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const send = (
    key: string,
    body = "Hi @Bob",
    mentions: any = [{ actorId: bob.actorId, start: 3, end: 7 }],
    extra: any = {},
  ) =>
    call(alice, "messages/send", {
      channelId: group.id,
      clientMessageId: key,
      parts: [{ type: "text", text: body }],
      ...(mentions === null ? {} : { mentions }),
      ...extra,
    });
  return {
    dir,
    storage,
    actors,
    service,
    alice,
    bob,
    outsider,
    group,
    call,
    send,
    close,
    human,
  };
}
test("human mentions persist with identity, viewer-relative highlighting, unread counters and no execution; plain names do nothing", async (t) => {
  const f = await fixture(t),
    r = await f.send("mention");
  assert.deepEqual(r.receipt.mentions, [
    {
      actorId: f.bob.actorId,
      start: 3,
      end: 7,
      displayName: "Bob",
      actorKind: "human",
      isSelf: false,
    },
  ]);
  const page = await f.call(f.bob, "messages/list", { channelId: f.group.id });
  assert.equal(page.messages[0].mentions[0].isSelf, true);
  const inbox = await f.service.communicate(f.bob, "inbox/sync", {});
  assert.equal(
    inbox.changes.find((c: any) => c.channelId === f.group.id).item
      .mentionUnreadCount,
    1,
  );
  assert.equal(page.messages[0].executionRequests, undefined);
  assert.equal(
    (await f.send("mention")).receipt.messageId,
    r.receipt.messageId,
  );
  await assert.rejects(
    f.send("mention", "Hi @Bob", []),
    /idempotency_key_reused/,
  );
  await f.send("plain", "Hi @Bob", null);
  const next = await f.service.communicate(f.bob, "inbox/sync", {});
  assert.equal(
    next.changes.find((c: any) => c.channelId === f.group.id).item
      .mentionUnreadCount,
    1,
  );
  await f.call(f.bob, "read", {
    channelId: f.group.id,
    throughSequence: r.receipt.sequence,
  });
  const stillPending = await f.service.communicate(f.bob, "inbox/sync", {});
  assert.equal(
    stillPending.changes.find((c: any) => c.channelId === f.group.id).item
      .mentionUnreadCount,
    1,
  );
  await f.call(f.bob, "mentions/ack", {
    channelId: f.group.id,
    messageId: r.receipt.messageId,
  });
  const read = await f.service.communicate(f.bob, "inbox/sync", {});
  assert.equal(
    read.changes.find((c: any) => c.channelId === f.group.id).item
      .mentionUnreadCount,
    0,
  );
});
test("forged members, ranges, stale labels, overlapping spans, unknown fields and human wakes fail atomically", async (t) => {
  const f = await fixture(t);
  for (const mentions of [
    [{ actorId: f.outsider.actorId, start: 3, end: 7 }],
    [{ actorId: f.bob.actorId, start: 0, end: 7 }],
    [{ actorId: f.bob.actorId, start: 3, end: 999 }],
    [{ actorId: f.bob.actorId, start: 3, end: 7, label: "Alice" }],
    [
      { actorId: f.bob.actorId, start: 3, end: 7 },
      { actorId: f.bob.actorId, start: 3, end: 7 },
    ],
  ])
    await assert.rejects(
      f.send("bad-" + JSON.stringify(mentions), "Hi @Bob", mentions),
      /channel_mention|channel_denied/,
    );
  await assert.rejects(
    f.send("wake-human", "Hi @Bob", undefined, {
      wakeActorIds: [f.bob.actorId],
    }),
  );
  assert.equal(
    (await f.call(f.alice, "messages/list", { channelId: f.group.id })).messages
      .length,
    0,
  );
  await assert.rejects(
    f.call(f.outsider, "messages/send", {
      channelId: f.group.id,
      clientMessageId: "foreign",
      parts: [{ type: "text", text: "@Bob" }],
      mentions: [{ actorId: f.bob.actorId, start: 0, end: 4 }],
    }),
    /channel_denied/,
  );
});
test("removal/rejoin does not resurrect old mention alerts; lost-ack retries cannot be retargeted", async (t) => {
  const f = await fixture(t),
    first = await f.send("once");
  await f.call(f.alice, "group/member/set", {
    channelId: f.group.id,
    actorId: f.bob.actorId,
    present: false,
    clientRequestId: "remove",
  });
  await assert.rejects(f.send("new"), /channel_mention_unavailable/);
  assert.equal(
    (await f.send("once")).receipt.messageId,
    first.receipt.messageId,
  );
  await f.call(f.alice, "group/member/set", {
    channelId: f.group.id,
    actorId: f.bob.actorId,
    present: true,
    clientRequestId: "join",
  });
  const inbox = await f.service.communicate(f.bob, "inbox/sync", {});
  assert.equal(
    inbox.changes.find((c: any) => c.channelId === f.group.id).item
      .mentionUnreadCount,
    0,
  );
});
test("reopening the database retains native mention identity and read scope", async (t) => {
  const f = await fixture(t);
  await f.send("persist");
  await f.close();
  const storage = await openServerDatabase(f.dir),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  try {
    const bob = actors.resolveHuman(
      parsePrincipal({
        provider: "local",
        subject: "Bob",
        displayName: "Bob",
        expiresAt: Date.now() + 60000,
      })!,
    )!;
    const page = await service.communicate(
      bob,
      "opencraft/channels/messages/list",
      { channelId: f.group.id },
    );
    assert.equal(page.messages[0].mentions[0].actorId, bob.actorId);
    assert.equal(page.messages[0].mentions[0].isSelf, true);
  } finally {
    await service.close();
    actors.close();
    await storage.close();
  }
});
test("composer preserves exact nested text/emoji offsets and separates person mentions from bot wakes", () => {
  const mention = (
    id: string,
    label: string,
    kind: "person" | "agent",
    channelId = "g",
  ): any => ({
    type: "mention",
    id,
    label,
    mentionKind: kind,
    metadata: { channelId, canWake: kind === "agent" },
  });
  const doc: ComposerDocument = {
    version: 1,
    blocks: [
      {
        type: "paragraph",
        children: [
          { type: "text", text: "😀 " },
          mention("human", "同事", "person"),
          { type: "text", text: " @手打" },
        ],
      },
      {
        type: "quote",
        children: [
          {
            type: "list",
            ordered: true,
            start: 3,
            items: [
              {
                children: [
                  {
                    type: "paragraph",
                    children: [mention("bot", "助理", "agent")],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        children: [mention("foreign", "别群", "person", "other")],
      },
    ],
  };
  const p = channelComposerPayload(doc, "g");
  assert.equal(p.text, composerDocumentToPlainText(doc));
  assert.deepEqual(p.wakeActorIds, ["bot"]);
  assert.deepEqual(
    p.mentions.map((m) => [m.actorId, p.text.slice(m.start, m.end)]),
    [
      ["human", "@同事"],
      ["bot", "@助理"],
    ],
  );
  const html = renderToStaticMarkup(
    <ChannelMentionText
      message={{
        sequence: 1,
        author: "A",
        text: p.text,
        at: 1,
        status: "received",
        mentions: p.mentions.map((m) => ({
          ...m,
          displayName: p.text.slice(m.start + 1, m.end),
          actorKind: m.actorId === "bot" ? "session" : "human",
          isSelf: m.actorId === "human",
        })),
      }}
    />,
  );
  assert.match(html, /data-self="true"/);
  assert.match(html, /@手打/);
  assert.equal((html.match(/class="im-channel-mention"/g) || []).length, 2);
});
test("the previous populated schema upgrades additively and a changed mention migration checksum refuses reopen", async (t) => {
  const { openManagedDatabase } = await import("@opencraft/sqlite-node");
  const { SERVER_MIGRATIONS } = await import("@opencraft/storage-node/server");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "mention-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "previous.sqlite");
  const previous = openManagedDatabase({
      path,
      migrations: SERVER_MIGRATIONS.slice(0, -1),
    }),
    actors = new ActorStore(previous),
    actor = actors.createSession("Retained identity", "fixture");
  const ledger = previous.database
    .prepare("SELECT * FROM schema_migrations ORDER BY version")
    .all();
  actors.close();
  previous.database.close();
  const upgraded = openManagedDatabase({ path, migrations: SERVER_MIGRATIONS });
  try {
    const restored = new ActorStore(upgraded);
    assert.deepEqual(restored.get(actor.id), actor);
    restored.close();
    assert.deepEqual(
      upgraded.database
        .prepare(
          "SELECT * FROM schema_migrations WHERE version<? ORDER BY version",
        )
        .all(SERVER_MIGRATIONS.at(-1)!.version),
      ledger,
    );
    assert.equal(
      upgraded.database
        .prepare("SELECT count(*) AS n FROM actor_channel_mentions")
        .get()!.n,
      0,
    );
  } finally {
    upgraded.database.close();
  }
  const tampered = new DatabaseSync(path);
  tampered
    .prepare("UPDATE schema_migrations SET checksum='changed' WHERE version=?")
    .run(SERVER_MIGRATIONS.at(-1)!.version);
  tampered.close();
  assert.throws(
    () => openManagedDatabase({ path, migrations: SERVER_MIGRATIONS }),
    /checksum|history/i,
  );
});
test("selected bot identity and wake grants remain separate; denied execution is atomic", async (t) => {
  const f = await fixture(t),
    bot = f.actors.createSession("Build Bot", f.alice.actorId);
  await f.call(f.alice, "group/member/set", {
    channelId: f.group.id,
    actorId: bot.id,
    present: true,
    clientRequestId: "add-bot",
  });
  const mentions = [{ actorId: bot.id, start: 0, end: 10 }];
  // A member without execution permission can still refer to the bot, without running it.
  const noted = await f.call(f.bob, "messages/send", {
    channelId: f.group.id,
    clientMessageId: "note-bot",
    parts: [{ type: "text", text: "@Build Bot FYI" }],
    mentions,
  });
  assert.equal(noted.receipt.executionRequests, undefined);
  assert.equal(noted.receipt.mentions[0].actorKind, "session");
  await assert.rejects(
    f.call(f.bob, "messages/send", {
      channelId: f.group.id,
      clientMessageId: "denied-wake",
      parts: [{ type: "text", text: "@Build Bot execute" }],
      mentions,
      wakeActorIds: [bot.id],
    }),
  );
  assert.equal(
    (await f.call(f.alice, "messages/list", { channelId: f.group.id })).messages
      .length,
    1,
  );
});

test("an unseen @ survives a latest-50 read; acknowledgements are scoped, idempotent and durable", async (t) => {
  const f = await fixture(t),
    first = await f.send("old");
  for (let i = 0; i < 55; i++) await f.send("plain-" + i, "later " + i, null);
  const second = await f.send("second");
  const inbox = async () =>
    (await f.service.communicate(f.bob, "inbox/sync", {})).changes.find(
      (c: any) => c.channelId === f.group.id,
    ).item;
  const page = await f.call(f.bob, "messages/list", { channelId: f.group.id });
  assert.equal(page.messages.length, 50);
  assert.ok(
    !page.messages.some((m: any) => m.messageId === first.receipt.messageId),
  );
  await f.call(f.bob, "read", {
    channelId: f.group.id,
    throughSequence: second.receipt.sequence,
  });
  assert.equal((await inbox()).unreadCount, 0);
  assert.equal((await inbox()).mentionUnreadCount, 2);
  assert.equal(
    (await inbox()).firstUnreadMentionSequence,
    first.receipt.sequence,
  );
  const ack = (who: any, id: string, extra: any = {}) =>
    f.call(who, "mentions/ack", {
      channelId: f.group.id,
      messageId: id,
      ...extra,
    });
  await assert.rejects(
    ack(f.outsider, first.receipt.messageId),
    /channel_denied/,
  );
  await assert.rejects(
    ack(f.alice, first.receipt.messageId),
    /channel_mention_unavailable/,
  );
  await assert.rejects(ack(f.bob, "absent"), /channel_mention_unavailable/);
  await assert.rejects(
    ack(f.bob, first.receipt.messageId, { actorId: f.alice.actorId }),
  );
  await ack(f.bob, first.receipt.messageId);
  await ack(f.bob, first.receipt.messageId);
  assert.equal((await inbox()).mentionUnreadCount, 1);
  assert.equal(
    (await inbox()).firstUnreadMentionSequence,
    second.receipt.sequence,
  );
  let history = await f.call(f.bob, "messages/around", {
    channelId: f.group.id,
    sequence: first.receipt.sequence,
  });
  // The current viewer alone gets the receipt projection.
  assert.equal(
    history.messages.find((m: any) => m.messageId === first.receipt.messageId)
      .mentions[0].isUnread,
    false,
  );
  await f.call(f.alice, "group/member/set", {
    channelId: f.group.id,
    actorId: f.bob.actorId,
    present: false,
    clientRequestId: "leave",
  });
  await f.call(f.alice, "group/member/set", {
    channelId: f.group.id,
    actorId: f.bob.actorId,
    present: true,
    clientRequestId: "rejoin",
  });
  await assert.rejects(
    ack(f.bob, second.receipt.messageId),
    /channel_mention_unavailable/,
  );
  assert.equal((await inbox()).mentionUnreadCount, 0);
  const fresh = await f.send("fresh");
  await ack(f.bob, fresh.receipt.messageId);
  await f.close();
  const storage = await openServerDatabase(f.dir),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  try {
    const bob = actors.resolveHuman(
      parsePrincipal({
        provider: "local",
        subject: "Bob",
        displayName: "Bob",
        expiresAt: Date.now() + 60000,
      })!,
    )!;
    const result: any = await service.communicate(bob, "inbox/sync", {});
    assert.equal(
      result.changes.find((c: any) => c.channelId === f.group.id).item
        .mentionUnreadCount,
      0,
    );
  } finally {
    await service.close();
    actors.close();
    await storage.close();
  }
});
test("mention-read migration preserves the old read watermark but not unseen alerts", async (t) => {
  const { openManagedDatabase } = await import("@opencraft/sqlite-node");
  const { SERVER_MIGRATIONS } = await import("@opencraft/storage-node/server");
  // Public and downstream append positions differ; the tested migration's
  // logical identity and all watermark/alert assertions remain the same.
  const mentionReadMigrations = SERVER_MIGRATIONS.filter(migration => migration.name.endsWith("_visible_mention_reads"));
  assert.equal(mentionReadMigrations.length, 1, "visible-mention-read migration must be unambiguous");
  const mentionReadIndex = SERVER_MIGRATIONS.indexOf(mentionReadMigrations[0]!);
  assert.ok(mentionReadIndex > 0, "fixture must start before the named visible-mention-read migration");
  const dir = await mkdtemp(join(tmpdir(), "mention-read-upgrade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "old.sqlite"),
    old = openManagedDatabase({
      path,
      migrations: SERVER_MIGRATIONS.slice(0, mentionReadIndex),
    }),
    actors = new ActorStore(old);
  const human = (subject: string) =>
    actors.resolveHuman(
      parsePrincipal({
        provider: "local",
        subject,
        displayName: subject,
        expiresAt: Date.now() + 60000,
      })!,
    )!;
  const alice = human("Alice"),
    bob = human("Bob"),
    db = old.database;
  db.prepare("INSERT INTO actor_channels(id,owner_id,title) VALUES(?,?,?)").run(
    "room",
    alice.actorId,
    "Room",
  );
  db.prepare("INSERT INTO actor_channel_members VALUES(?,?,?)").run(
    "room",
    bob.actorId,
    "epoch",
  );
  db.prepare("INSERT INTO actor_channel_reads VALUES(?,?,?,?,?)").run(
    "room",
    bob.actorId,
    "epoch",
    0,
    1,
  );
  for (const seq of [1, 2]) {
    db.prepare(
      "INSERT INTO actor_messages(id,seq,channel_id,author_id,target_id,content,created_at,target_kind) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      "m" + seq,
      seq,
      "room",
      alice.actorId,
      "room",
      "Hi @Bob",
      Date.now(),
      "channel",
    );
    db.prepare("INSERT INTO actor_channel_mentions VALUES(?,?,?,?,?,?)").run(
      "m" + seq,
      bob.actorId,
      3,
      7,
      "Bob",
      "human",
    );
  }
  const ledger = db
    .prepare("SELECT * FROM schema_migrations ORDER BY version")
    .all();
  actors.close();
  db.close();
  const upgraded = openManagedDatabase({ path, migrations: SERVER_MIGRATIONS });
  try {
    assert.deepEqual(
      upgraded.database
        .prepare(
          "SELECT message_id FROM actor_channel_mention_reads ORDER BY message_id",
        )
        .all()
        .map((r: any) => r.message_id),
      ["m1"],
    );
    assert.deepEqual(
      upgraded.database
        .prepare(
          "SELECT * FROM schema_migrations WHERE version<? ORDER BY version",
        )
        .all(SERVER_MIGRATIONS[mentionReadIndex]!.version),
      ledger,
    );
  } finally {
    upgraded.database.close();
  }
});
