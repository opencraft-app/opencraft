import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openServerCoreOwner, type ServerCoreStorage } from "@opencraft/storage-node/server-owner";
import { ActorStore } from "@opencraft/access-control/actors";
import type { Principal } from "@opencraft/identity-core";
import { humanActorAccess } from "../../apps/headless-server/src/account-model-defaults-http.ts";
import {
  THREAD_READ_RECEIPTS_PATH,
  threadReadReceiptsHttp,
} from "../../apps/headless-server/src/thread-read-receipts-http.ts";

const id = (turn: string, thread = "thread", host = "host") => [host, thread, turn] as const;
const wire = (turn: string, thread = "thread", host = "host") => JSON.stringify(id(turn, thread, host));

async function owner(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "thread-read-receipts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, storage: await openServerCoreOwner(directory) };
}

test("the Server owner Worker only adds receipts, reads by cursor and isolates people across restart", async (t) => {
  const { directory, storage } = await owner(t);
  let reopened: ServerCoreStorage | undefined;
  try {
    assert.deepEqual(await storage.call.readThreadReadReceipts("human://a", 0), { cursor: 0, receipts: [] });
    assert.deepEqual(await storage.call.mergeThreadReadReceipts("human://a", [id("one"), id("two")]), { cursor: 2 });
    // A repeated or concurrent merge of known receipts changes nothing; a later read is added after them.
    const [again, later] = await Promise.all([
      storage.call.mergeThreadReadReceipts("human://a", [id("one")]),
      storage.call.mergeThreadReadReceipts("human://a", [id("three"), id("one")]),
    ]);
    assert.deepEqual(again, { cursor: 2 });
    assert.deepEqual(later, { cursor: 3 });
    assert.deepEqual(await storage.call.readThreadReadReceipts("human://a", 0), {
      cursor: 3,
      receipts: [id("one"), id("two"), id("three")],
    });
    assert.deepEqual(await storage.call.readThreadReadReceipts("human://a", 2), { cursor: 3, receipts: [id("three")] });
    assert.deepEqual(await storage.call.readThreadReadReceipts("human://a", 3), { cursor: 3, receipts: [] });
    // A cursor from beyond the person's latest change (a restored backup) reads everything again.
    assert.equal((await storage.call.readThreadReadReceipts("human://a", 99)).receipts.length, 3);
    await storage.call.mergeThreadReadReceipts("human://b", [id("other")]);
    assert.deepEqual(await storage.call.readThreadReadReceipts("human://b", 0), { cursor: 1, receipts: [id("other")] });

    // Malformed input is refused before any write.
    for (const input of [
      null,
      [["host", "thread"]],
      [["host", "thread", ""]],
      [["host", "thread", 1]],
      [["h", "t", "x".repeat(513)]],
      Array.from({ length: 129 }, (_, index) => id(String(index))),
    ]) {
      await assert.rejects(
        storage.call.mergeThreadReadReceipts("human://a", [
          id("valid-before-invalid"),
          ...(Array.isArray(input) ? input : [input]),
        ] as never),
        /Invalid read receipt/,
      );
    }
    for (const [actor, after] of [
      ["", 0],
      ["x".repeat(513), 0],
      ["human://a", -1],
      ["human://a", 1.5],
    ] as const)
      await assert.rejects(storage.call.readThreadReadReceipts(actor, after), /Invalid read receipt/);
    assert.equal((await storage.call.readThreadReadReceipts("human://a", 0)).cursor, 3);

    await storage.close();
    reopened = await openServerCoreOwner(directory);
    assert.deepEqual(await reopened.call.readThreadReadReceipts("human://a", 0), {
      cursor: 3,
      receipts: [id("one"), id("two"), id("three")],
    });
    assert.deepEqual((await reopened.call.readThreadReadReceipts("human://b", 0)).receipts, [id("other")]);
  } finally {
    await storage.close();
    await reopened?.close();
  }
});

test("each Thread and each person stay bounded by evicting their oldest receipts", async (t) => {
  const { storage } = await owner(t);
  try {
    // Ten Turns of one Thread keep the eight newest; a stale device's late read of an older Turn is newest.
    await storage.call.mergeThreadReadReceipts(
      "human://a",
      Array.from({ length: 10 }, (_, index) => id(`turn-${index}`)),
    );
    await storage.call.mergeThreadReadReceipts("human://a", [id("turn-0")]);
    const thread = (await storage.call.readThreadReadReceipts("human://a", 0)).receipts.map((receipt) => receipt[2]);
    assert.deepEqual(thread, ["turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8", "turn-9", "turn-0"]);

    // 4224 Threads in 33 merges keep the person's 4096 newest receipts and never touch another person.
    await storage.call.mergeThreadReadReceipts("human://b", [id("kept")]);
    for (let batch = 0; batch < 33; batch++)
      await storage.call.mergeThreadReadReceipts(
        "human://a",
        Array.from({ length: 128 }, (_, index) => id("t", `thread-${batch * 128 + index}`)),
      );
    const page = await storage.call.readThreadReadReceipts("human://a", 0);
    assert.equal(page.receipts.length, 4096);
    assert.deepEqual(page.receipts[0], id("t", "thread-128"));
    assert.deepEqual(page.receipts.at(-1), id("t", "thread-4223"));
    assert.equal(page.cursor, 11 + 33 * 128, "eviction never rewinds the cursor");
    assert.deepEqual((await storage.call.readThreadReadReceipts("human://b", 0)).receipts, [id("kept")]);
  } finally {
    await storage.close();
  }
});

test("receipt writes wait in the Worker while the network thread keeps serving timers", async (t) => {
  const { storage } = await owner(t);
  let settled = false;
  storage.database.exec("BEGIN IMMEDIATE");
  const pending = storage.call.mergeThreadReadReceipts("human://a", [id("waiting")]).finally(() => {
    settled = true;
  });
  try {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    clearInterval(timer);
    assert.equal(settled, false);
    assert.ok(ticks >= 3, "timers kept running while the owner waited for the lock");
  } finally {
    storage.database.exec("ROLLBACK");
  }
  try {
    assert.deepEqual(await pending, { cursor: 1 });
  } finally {
    await storage.close();
  }
  // A closed owner fences every later call; nothing runs on this thread instead.
  await assert.rejects(storage.call.readThreadReadReceipts("human://a", 0), /closed|failed|stopped/);
});

interface Fixture {
  readonly url: string;
  readonly actors: ActorStore;
  readonly storage: ServerCoreStorage;
  readonly admitted: Set<string>;
  readonly principals: Map<string, Principal>;
  readonly sessions: Set<string>;
}

async function routeFixture(
  t: test.TestContext,
  options: { storage?: Parameters<typeof threadReadReceiptsHttp>[0] } = {},
): Promise<Fixture> {
  const { storage } = await owner(t);
  const actors = new ActorStore(storage);
  const admitted = new Set<string>();
  const principals = new Map<string, Principal>();
  const sessions = new Set<string>();
  // The real login gateway resolves a cookie to a verified principal; this fixture uses a header.
  const authenticate = (request: IncomingMessage) => {
    const token = request.headers["x-fixture-login"];
    if (typeof token === "string" && sessions.has(token)) {
      const session = actors.createSession("Session", "fixture");
      return {
        actorId: session.id,
        generation: session.generation,
        credentialId: "credential",
        expiresAt: Date.now() + 60_000,
      };
    }
    const principal = typeof token === "string" ? principals.get(token) : undefined;
    return principal ? actors.resolveHuman(principal) : null;
  };
  const handler = threadReadReceiptsHttp(
    options.storage ?? storage.call,
    humanActorAccess({
      authenticate,
      isCurrentHuman: (context) => actors.isCurrent(context) && actors.get(context.actorId)?.kind === "human",
      admits: (actorId) => admitted.has(actorId),
      trustedOrigin: () => null,
    }),
  );
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    actors.close();
    await storage.close();
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    actors,
    storage,
    admitted,
    principals,
    sessions,
  };
}

function login(f: Fixture, token: string, subject: string, provider = "local") {
  const principal = { provider, subject, displayName: subject, expiresAt: Date.now() + 600_000 };
  f.principals.set(token, principal);
  const actorId = f.actors.resolveHuman(principal)!.actorId;
  f.admitted.add(actorId);
  return actorId;
}
const read = (f: Fixture, token: string, expectedActorId: string, after = 0) =>
  fetch(`${f.url}${THREAD_READ_RECEIPTS_PATH}?${new URLSearchParams({ expectedActorId, after: String(after) })}`, {
    headers: { "x-fixture-login": token },
  });
const merge = (f: Fixture, token: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(f.url + THREAD_READ_RECEIPTS_PATH, {
    method: "POST",
    headers: { "x-fixture-login": token, origin: f.url, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("the route admits only the verified, admitted human Actor and refuses cross-site writes", async (t) => {
  const f = await routeFixture(t);
  assert.equal((await fetch(f.url + THREAD_READ_RECEIPTS_PATH)).status, 401);
  assert.equal((await merge(f, "nobody", { receipts: [wire("x")], expectedActorId: "human://x" })).status, 401);
  const aliceId = login(f, "alice", "alice");
  f.admitted.delete(aliceId);
  assert.equal(
    (await fetch(f.url + THREAD_READ_RECEIPTS_PATH, { headers: { "x-fixture-login": "alice" } })).status,
    403,
    "no instance admission",
  );
  f.admitted.add(aliceId);
  assert.deepEqual(
    await (await fetch(f.url + THREAD_READ_RECEIPTS_PATH, { headers: { "x-fixture-login": "alice" } })).json(),
    { actorId: aliceId },
  );
  f.sessions.add("bot");
  assert.equal(
    (await fetch(f.url + THREAD_READ_RECEIPTS_PATH, { headers: { "x-fixture-login": "bot" } })).status,
    403,
    "a Session credential is not a person",
  );

  const saved = await merge(f, "alice", { receipts: [wire("one"), wire("two")], expectedActorId: aliceId });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { actorId: aliceId, cursor: 2, receipts: [wire("one"), wire("two")] });
  assert.deepEqual(await (await read(f, "alice", aliceId)).json(), {
    actorId: aliceId,
    cursor: 2,
    receipts: [wire("one"), wire("two")],
  });
  assert.deepEqual(await (await read(f, "alice", aliceId, 1)).json(), {
    actorId: aliceId,
    cursor: 2,
    receipts: [wire("two")],
  });

  // Cross-site and non-JSON writes are refused before reading the body.
  for (const headers of [
    { origin: "https://elsewhere.example" },
    { "sec-fetch-site": "cross-site" },
    { "content-type": "text/plain" },
  ]) {
    const response = await merge(f, "alice", { receipts: [wire("forged")], expectedActorId: aliceId }, headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal((await response.json()).error, "same_origin_required");
  }
  const noOrigin = await fetch(f.url + THREAD_READ_RECEIPTS_PATH, {
    method: "POST",
    headers: { "x-fixture-login": "alice", "content-type": "application/json" },
    body: JSON.stringify({ receipts: [wire("forged")], expectedActorId: aliceId }),
  });
  assert.equal(noOrigin.status, 403);

  // Malformed input is refused without touching the record.
  for (const body of [
    { receipts: null, expectedActorId: aliceId },
    { receipts: ["not-json"], expectedActorId: aliceId },
    { receipts: [JSON.stringify(["host", "thread"])], expectedActorId: aliceId },
    { receipts: [JSON.stringify(["host", "thread", ""])], expectedActorId: aliceId },
    { receipts: Array.from({ length: 129 }, (_, index) => wire(String(index))), expectedActorId: aliceId },
    { receipts: [wire("x")], expectedActorId: aliceId, actorId: "human://other" },
  ])
    assert.equal((await merge(f, "alice", body)).status, 400, JSON.stringify(body).slice(0, 120));
  for (const after of ["-1", "1.5", "x", "99999999999999999"])
    assert.equal(
      (
        await fetch(
          `${f.url}${THREAD_READ_RECEIPTS_PATH}?${new URLSearchParams({ expectedActorId: aliceId, after })}`,
          { headers: { "x-fixture-login": "alice" } },
        )
      ).status,
      400,
    );
  assert.equal(
    (await fetch(f.url + THREAD_READ_RECEIPTS_PATH, { method: "PUT", headers: { "x-fixture-login": "alice" } })).status,
    405,
  );
  assert.equal((await (await read(f, "alice", aliceId)).json()).cursor, 2);
});

test("one person never reads or writes another's receipts, and all their logins share them", async (t) => {
  const f = await routeFixture(t);
  const aliceId = login(f, "alice-local", "alice");
  const bobId = login(f, "bob", "bob");
  assert.equal(
    (await merge(f, "alice-local", { receipts: [wire("alice-read")], expectedActorId: aliceId })).status,
    200,
  );

  // Naming another Actor only fences the request; it never selects that person's receipts.
  const foreignRead = await read(f, "bob", aliceId);
  assert.equal(foreignRead.status, 409);
  assert.equal((await foreignRead.json()).error, "account_changed");
  assert.equal((await merge(f, "bob", { receipts: [wire("hijack")], expectedActorId: aliceId })).status, 409);
  assert.deepEqual(await (await read(f, "bob", bobId)).json(), { actorId: bobId, cursor: 0, receipts: [] });
  assert.deepEqual((await (await read(f, "alice-local", aliceId)).json()).receipts, [wire("alice-read")]);

  // A second verified login bound to the same person shares the receipts.
  const oidc = {
    provider: "oidc.fixture",
    subject: "issuer-subject-digest",
    displayName: "alice",
    expiresAt: Date.now() + 600_000,
  };
  f.principals.set("alice-oidc", oidc);
  assert.equal(f.actors.bindHuman(f.actors.resolveHuman(f.principals.get("alice-local")!)!, oidc), true);
  assert.deepEqual((await (await read(f, "alice-oidc", aliceId)).json()).receipts, [wire("alice-read")]);
  assert.equal(
    (await merge(f, "alice-oidc", { receipts: [wire("second-login")], expectedActorId: aliceId })).status,
    200,
  );
  assert.deepEqual((await (await read(f, "alice-local", aliceId, 1)).json()).receipts, [wire("second-login")]);

  // Revoking admission refuses the person on every login.
  f.admitted.delete(aliceId);
  assert.equal((await read(f, "alice-oidc", aliceId)).status, 403);
  assert.equal((await read(f, "alice-local", aliceId)).status, 403);
});

test("a failed storage owner fails closed with no other read or write path", async (t) => {
  const failing = {
    readThreadReadReceipts: async () => {
      throw new Error("Server storage failed");
    },
    mergeThreadReadReceipts: async () => {
      throw new Error("Server storage failed");
    },
  };
  const f = await routeFixture(t, { storage: failing });
  const aliceId = login(f, "alice", "alice");
  const response = await read(f, "alice", aliceId);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "read_receipts_unavailable" });
  assert.equal((await merge(f, "alice", { receipts: [wire("x")], expectedActorId: aliceId })).status, 503);
  assert.equal(f.storage.database.prepare("SELECT count(*) AS n FROM thread_read_receipts").get()?.n, 0);
});
