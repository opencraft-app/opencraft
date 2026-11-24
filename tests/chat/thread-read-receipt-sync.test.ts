import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";
import { ActorStore } from "@opencraft/access-control/actors";
import type { Principal } from "@opencraft/identity-core";
import { humanActorAccess } from "../../apps/headless-server/src/account-model-defaults-http.ts";
import { threadReadReceiptsHttp } from "../../apps/headless-server/src/thread-read-receipts-http.ts";
import { BrowserThreadAttention } from "../../apps/workbench-web/src/runtime/browser-thread-attention";
import { PlatformAccountContributionRegistry } from "../../apps/workbench-web/src/runtime/platform-account-contributions";
import { ServerThreadReadReceipts } from "../../apps/workbench-web/src/runtime/server-thread-read-receipts";

const receipt = (turn: string) => JSON.stringify(["host", "thread", turn]);

/** A real Server owner Worker behind the real route; logins are a header instead of a cookie. */
async function server(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "thread-read-sync-"));
  const storage = await openServerCoreOwner(directory);
  const actors = new ActorStore(storage);
  const principals = new Map<string, Principal>();
  const authenticate = (request: IncomingMessage) => {
    const token = request.headers["x-fixture-login"];
    const principal = typeof token === "string" ? principals.get(token) : undefined;
    return principal ? actors.resolveHuman(principal) : null;
  };
  let available = true;
  const handler = threadReadReceiptsHttp(
    storage.call,
    humanActorAccess({
      authenticate,
      isCurrentHuman: (context) => actors.isCurrent(context) && actors.get(context.actorId)?.kind === "human",
      trustedOrigin: () => null,
    }),
  );
  const http = createServer((request, response) => {
    if (!available) {
      response.writeHead(404);
      response.end();
      return;
    }
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(async () => {
    http.close();
    actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url,
    storage,
    signIn(token: string, subject: string) {
      principals.set(token, { provider: "local", subject, displayName: subject, expiresAt: Date.now() + 600_000 });
      return actors.resolveHuman(principals.get(token)!)!.actorId;
    },
    signOut(token: string) {
      principals.delete(token);
    },
    withoutRoute() {
      available = false;
    },
  };
}

type Server = Awaited<ReturnType<typeof server>>;

/** One browser: its own login, storage and network; `offline` makes every request fail. */
function browser(s: Server, token: { value: string }) {
  const saved = new Map<string, string>();
  const network = { offline: false };
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
    removeItem: (key: string) => {
      saved.delete(key);
    },
  };
  const fetcher = (async (path: string, init: RequestInit = {}) => {
    if (network.offline) throw new TypeError("Failed to fetch");
    return fetch(s.url + path, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), origin: s.url, "x-fixture-login": token.value },
    });
  }) as typeof fetch;
  const open = async (accounts = new PlatformAccountContributionRegistry()) => {
    let complete: (result: { hostId: string; threadId: string; turnId: string }) => void = () => {};
    const source = await ServerThreadReadReceipts.discover(fetcher, { hint: storage, hintKey: "server-actor" });
    const store = new BrowserThreadAttention(
      { get: () => undefined } as never,
      {
        subscribe: (listener: typeof complete) => {
          complete = listener;
          return () => {};
        },
      } as never,
      accounts,
      storage,
      "test",
      0,
      source ?? null,
    );
    return {
      store,
      source,
      complete: (turn: string) => complete({ hostId: "host", threadId: "thread", turnId: turn }),
    };
  };
  return { saved, network, open };
}

test("two devices of one person converge on read state without flashing unread before the first refresh", async (t) => {
  const s = await server(t);
  s.signIn("alice", "alice");
  const phone = browser(s, { value: "alice" }),
    laptop = browser(s, { value: "alice" });
  const a = await phone.open(),
    b = await laptop.open();
  try {
    assert.ok(a.source?.getScope());
    assert.equal(a.store.getScope(), "local", "other local caches keep their partition");
    // A completion seen before the authority answered is not shown unread yet.
    b.complete("one");
    assert.equal(b.store.unread("host", "thread"), false);
    await Promise.all([a.store.synchronize(), b.store.synchronize()]);
    assert.equal(b.store.unread("host", "thread"), true);
    a.complete("one");
    a.store.acknowledge(a.store.getScope(), "host", "thread", "one");
    await a.store.synchronize();
    await b.store.synchronize();
    assert.equal(b.store.unread("host", "thread"), false, "read on the phone is read on the laptop");
    // A newer reply stays unread everywhere until it is read; a stale device re-reading the old Turn cannot hide it.
    a.complete("two");
    b.complete("two");
    b.store.acknowledge(b.store.getScope(), "host", "thread", "one");
    await b.store.synchronize();
    await a.store.synchronize();
    assert.equal(a.store.unread("host", "thread"), true);
    b.store.acknowledge(b.store.getScope(), "host", "thread", "two");
    await b.store.synchronize();
    await a.store.synchronize();
    assert.equal(a.store.unread("host", "thread"), false);
    // A new browser restores the person's reads.
    const fresh = await browser(s, { value: "alice" }).open();
    await fresh.store.synchronize();
    fresh.complete("two");
    assert.equal(fresh.store.unread("host", "thread"), false);
    fresh.store.dispose();
  } finally {
    a.store.dispose();
    b.store.dispose();
  }
});

test("a device offline at start keeps its reads, then reconciles when the server answers", async (t) => {
  const s = await server(t);
  const aliceId = s.signIn("alice", "alice");
  const phone = browser(s, { value: "alice" });
  const first = await phone.open();
  await first.store.synchronize();
  first.complete("before");
  first.store.acknowledge("local", "host", "thread", "before");
  await first.store.synchronize();
  first.store.dispose();

  phone.network.offline = true;
  const offline = await phone.open();
  assert.equal(offline.source?.getScope(), aliceId, "the remembered person restores offline display");
  await offline.store.synchronize();
  offline.complete("before");
  assert.equal(offline.store.unread("host", "thread"), false);
  offline.complete("while-offline");
  offline.store.acknowledge("local", "host", "thread", "while-offline");
  await offline.store.synchronize();
  offline.store.dispose();
  // Reload while still offline: the queued read survives in the person's slot.
  const reloaded = await phone.open();
  await reloaded.store.synchronize();
  reloaded.complete("while-offline");
  assert.equal(reloaded.store.unread("host", "thread"), false);
  phone.network.offline = false;
  await reloaded.store.synchronize();
  assert.deepEqual(
    (await s.storage.call.readThreadReadReceipts(aliceId, 0)).receipts.map((item) => item[2]),
    ["before", "while-offline"],
  );
  reloaded.store.dispose();
});

test("sign-out and account switch remove the previous person's receipts from the browser", async (t) => {
  const s = await server(t);
  const aliceId = s.signIn("alice", "alice");
  const bobId = s.signIn("bob", "bob");
  const login = { value: "alice" };
  const shared = browser(s, login);
  const device = await shared.open();
  try {
    await device.store.synchronize();
    device.complete("alice-turn");
    device.store.acknowledge("local", "host", "thread", "alice-turn");
    await device.store.synchronize();
    assert.match(shared.saved.get("test.server-account") ?? "", /alice-turn/);

    // Another person signs in on the same browser: the server fences, the slot is replaced.
    login.value = "bob";
    await assert.rejects(device.source!.port.read(aliceId, AbortSignal.timeout(5000)), /account_changed/);
    await device.source!.refresh();
    assert.equal(device.source!.getScope(), bobId);
    await device.store.synchronize();
    device.complete("alice-turn");
    assert.equal(device.store.unread("host", "thread"), true, "Bob never sees Alice's reads");
    assert.doesNotMatch(shared.saved.get("test.server-account") ?? "", /alice-turn/);
    assert.equal(shared.saved.get("server-actor"), bobId);

    // Signing out removes Bob's receipts and the remembered person.
    s.signOut("bob");
    await device.source!.refresh();
    assert.equal(device.source!.getScope(), null);
    assert.equal(shared.saved.has("test.server-account"), false);
    assert.equal(shared.saved.has("server-actor"), false);
    assert.deepEqual(
      (await s.storage.call.readThreadReadReceipts(aliceId, 0)).receipts.map((item) => item[2]),
      ["alice-turn"],
    );
    assert.deepEqual((await s.storage.call.readThreadReadReceipts(bobId, 0)).receipts, []);
  } finally {
    device.store.dispose();
  }

  // A browser that starts signed out drops any slot left behind.
  const stale = browser(s, { value: "nobody" });
  stale.saved.set("test.server-account", JSON.stringify({ actorId: aliceId, receipts: [receipt("leftover")] }));
  const signedOut = await stale.open();
  assert.equal(signedOut.source?.getScope(), null);
  assert.equal(stale.saved.has("test.server-account"), false);
  signedOut.store.dispose();
});

test("existing browser reads go to the first signed-in person once; servers without the route stay local", async (t) => {
  const s = await server(t);
  const aliceId = s.signIn("alice", "alice");
  const legacy = browser(s, { value: "alice" });
  legacy.saved.set('test:"local"', JSON.stringify([receipt("legacy")]));
  const device = await legacy.open();
  await device.store.synchronize();
  device.complete("legacy");
  assert.equal(device.store.unread("host", "thread"), false);
  assert.deepEqual(
    (await s.storage.call.readThreadReadReceipts(aliceId, 0)).receipts.map((item) => item[2]),
    ["legacy"],
  );
  device.store.dispose();
  legacy.saved.delete("test.server-account");
  s.signIn("alice-again", "bob");
  const again = await browser(s, { value: "alice-again" }).open();
  again.store.dispose();
  assert.equal(legacy.saved.get("test.server-imported"), "1");

  s.withoutRoute();
  const local = browser(s, { value: "alice" });
  const opened = await local.open();
  assert.equal(opened.source, undefined);
  opened.complete("t");
  opened.store.acknowledge("local", "host", "thread", "t");
  assert.equal(opened.store.unread("host", "thread"), false);
  assert.ok(local.saved.has('test:"local"'));
  opened.store.dispose();
});

test("a product account's own read receipt port takes precedence over the server's", async (t) => {
  const s = await server(t);
  const aliceId = s.signIn("alice", "alice");
  const product: string[] = [];
  const contribution = {
    readReceipts: {
      read: async () => [...product],
      merge: async (_scope: string, receipts: readonly string[]) => {
        product.push(...receipts);
        return receipts;
      },
    },
    getSnapshot: () => ({ phase: "authenticated", readStateScope: "product-scope" }),
    subscribe: () => () => {},
  };
  const accounts = {
    getSnapshot: () => ({ contribution }),
    subscribe: () => () => {},
  } as unknown as PlatformAccountContributionRegistry;
  const device = await browser(s, { value: "alice" }).open(accounts);
  try {
    assert.equal(device.store.getScope(), "product-scope");
    await device.store.synchronize();
    device.complete("turn");
    device.store.acknowledge("product-scope", "host", "thread", "turn");
    await device.store.synchronize();
    assert.deepEqual(product, [receipt("turn")]);
    assert.deepEqual((await s.storage.call.readThreadReadReceipts(aliceId, 0)).receipts, []);
  } finally {
    device.store.dispose();
  }
});

test("a product account that signs out removes its cached receipts", async () => {
  const saved = new Map<string, string>([['test:"a"', JSON.stringify([receipt("kept-until-sign-out")])]]);
  let snapshot: { phase: string; readStateScope: string | null } = { phase: "authenticated", readStateScope: "a" };
  let changed = () => {};
  const contribution = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      changed = listener;
      return () => {};
    },
  };
  const accounts = {
    getSnapshot: () => ({ contribution }),
    subscribe: () => () => {},
  } as unknown as PlatformAccountContributionRegistry;
  const store = new BrowserThreadAttention(
    { get: () => undefined } as never,
    { subscribe: () => () => {} } as never,
    accounts,
    {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value);
      },
      removeItem: (key) => {
        saved.delete(key);
      },
    },
    "test",
  );
  snapshot = { phase: "loading", readStateScope: null };
  changed();
  assert.equal(saved.has('test:"a"'), true, "a refresh in progress is not a sign-out");
  snapshot = { phase: "authenticated", readStateScope: "a" };
  changed();
  snapshot = { phase: "anonymous", readStateScope: null };
  changed();
  assert.equal(saved.has('test:"a"'), false);
  assert.equal(store.getScope(), null);
  store.dispose();
});
