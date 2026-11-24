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
import {
  ACCOUNT_MODEL_DEFAULTS_PATH,
  accountModelDefaultsHttp,
  humanActorAccess,
} from "../../apps/headless-server/src/account-model-defaults-http.ts";
import { serveNodeHttpExchange } from "@opencraft/http-exchange/node";

const selection = { model: "provider/model", effort: "high", serviceTier: "priority" };

async function owner(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "account-model-defaults-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, storage: await openServerCoreOwner(directory) };
}

test("the Server owner Worker keeps per-Actor, per-Host records with revision CAS across restart", async (t) => {
  const { directory, storage } = await owner(t);
  let reopened: ServerCoreStorage | undefined;
  try {
    assert.deepEqual(await storage.call.readAccountModelDefaults("human://a", "host"), { revision: 0, selection: null });
    // Two devices race from the same revision: exactly one commits, the stale one is refused.
    const [first, second] = await Promise.all([
      storage.call.compareAndSetAccountModelDefaults("human://a", "host", 0, selection),
      storage.call.compareAndSetAccountModelDefaults("human://a", "host", 0, { model: "stale", effort: null }),
    ]);
    assert.equal(first.updated, true);
    assert.equal(second.updated, false);
    assert.deepEqual(second.record, { revision: 1, selection });
    assert.equal((await storage.call.compareAndSetAccountModelDefaults("human://a", "host", 0, { model: "late", effort: null })).updated, false);
    await storage.call.compareAndSetAccountModelDefaults("human://b", "host", 0, { model: "b-model", effort: null });
    await storage.call.compareAndSetAccountModelDefaults("human://a", "other", 0, { model: "other-host", effort: null });
    await storage.close();
    reopened = await openServerCoreOwner(directory);
    assert.deepEqual(await reopened.call.readAccountModelDefaults("human://a", "host"), { revision: 1, selection });
    assert.equal(((await reopened.call.readAccountModelDefaults("human://b", "host")).selection as { model: string }).model, "b-model");
    assert.equal(((await reopened.call.readAccountModelDefaults("human://a", "other")).selection as { model: string }).model, "other-host");
    const standard = { ...selection, serviceTier: null };
    assert.equal((await reopened.call.compareAndSetAccountModelDefaults("human://a", "host", 1, standard)).updated, true);
    assert.deepEqual(await reopened.call.readAccountModelDefaults("human://a", "host"), { revision: 2, selection: standard });
    for (const [actor, host] of [["", "host"], ["human://a", " "], ["human://a", "x".repeat(513)]]) {
      await assert.rejects(reopened.call.readAccountModelDefaults(actor, host), /Invalid model defaults/);
    }
    await assert.rejects(reopened.call.compareAndSetAccountModelDefaults("human://a", "host", 2, null as never), /Invalid model selection/);
    // A record written by a newer format is neither reinterpreted nor overwritten.
    reopened.database.prepare("UPDATE account_model_defaults SET format=2 WHERE actor_id=? AND host_id=?").run("human://b", "host");
    await assert.rejects(reopened.call.readAccountModelDefaults("human://b", "host"), /Unsupported model defaults format/);
    await assert.rejects(reopened.call.compareAndSetAccountModelDefaults("human://b", "host", 1, selection), /Unsupported model defaults format/);
    assert.equal(reopened.database.prepare("SELECT revision FROM account_model_defaults WHERE actor_id='human://b'").get()?.revision, 1);
  } finally {
    await storage.close();
    await reopened?.close();
  }
});

test("model defaults writes wait in the Worker while the network thread keeps serving timers", async (t) => {
  const { storage } = await owner(t);
  let settled = false;
  storage.database.exec("BEGIN IMMEDIATE");
  const pending = storage.call.compareAndSetAccountModelDefaults("human://a", "host", 0, selection).finally(() => { settled = true; });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false);
  } finally {
    storage.database.exec("ROLLBACK");
  }
  try {
    assert.equal((await pending).updated, true);
  } finally {
    await storage.close();
  }
  // A closed or failed owner fences every later call; nothing runs on this thread instead.
  await assert.rejects(storage.call.readAccountModelDefaults("human://a", "host"), /closed|failed|stopped/);
});

interface Fixture {
  readonly url: string;
  readonly actors: ActorStore;
  readonly storage: ServerCoreStorage;
  readonly admitted: Set<string>;
  readonly principals: Map<string, Principal>;
  readonly sessions: Set<string>;
}

async function routeFixture(t: test.TestContext, options: { storage?: Parameters<typeof accountModelDefaultsHttp>[0] } = {}): Promise<Fixture> {
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
      return { actorId: session.id, generation: session.generation, credentialId: "credential", expiresAt: Date.now() + 60_000 };
    }
    const principal = typeof token === "string" ? principals.get(token) : undefined;
    return principal ? actors.resolveHuman(principal) : null;
  };
  const handler = accountModelDefaultsHttp(options.storage ?? storage.call, humanActorAccess({
    authenticate,
    isCurrentHuman: (context) => actors.isCurrent(context) && actors.get(context.actorId)?.kind === "human",
    admits: (actorId) => admitted.has(actorId),
    trustedOrigin: () => null,
  }));
  const server = createServer((request, response) => {
    void serveNodeHttpExchange(request, response, handler).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    actors.close();
    await storage.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, actors, storage, admitted, principals, sessions };
}

function login(f: Fixture, token: string, subject: string, provider = "local"): Principal {
  const principal = { provider, subject, displayName: subject, expiresAt: Date.now() + 600_000 };
  f.principals.set(token, principal);
  return principal;
}

const read = (f: Fixture, token: string, hostId: string, expectedActorId: string) =>
  fetch(`${f.url}${ACCOUNT_MODEL_DEFAULTS_PATH}?${new URLSearchParams({ hostId, expectedActorId })}`, { headers: { "x-fixture-login": token } });
const write = (f: Fixture, token: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(f.url + ACCOUNT_MODEL_DEFAULTS_PATH, {
    method: "POST",
    headers: { "x-fixture-login": token, origin: f.url, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function actorOf(f: Fixture, token: string) {
  const response = await fetch(f.url + ACCOUNT_MODEL_DEFAULTS_PATH, { headers: { "x-fixture-login": token } });
  assert.equal(response.status, 200);
  return ((await response.json()) as { actorId: string }).actorId;
}

test("the route serves the verified human Actor only, with admission and CAS", async (t) => {
  const f = await routeFixture(t);
  assert.equal((await fetch(f.url + ACCOUNT_MODEL_DEFAULTS_PATH)).status, 401);
  login(f, "alice", "alice");
  const alice = (await fetch(f.url + ACCOUNT_MODEL_DEFAULTS_PATH, { headers: { "x-fixture-login": "alice" } }));
  assert.equal(alice.status, 403, "an authenticated human without instance admission is refused");
  const aliceId = f.actors.findHuman({ provider: "local", subject: "alice" })!.id;
  f.admitted.add(aliceId);
  assert.equal(await actorOf(f, "alice"), aliceId);
  f.sessions.add("bot");
  assert.equal((await fetch(f.url + ACCOUNT_MODEL_DEFAULTS_PATH, { headers: { "x-fixture-login": "bot" } })).status, 403, "a Session credential is not a person");

  assert.deepEqual(await (await read(f, "alice", "host", aliceId)).json(), { actorId: aliceId, revision: 0, selection: null });
  // Two devices of the same person race from revision 0; the stale write is refused with the current record.
  const [one, two] = await Promise.all([
    write(f, "alice", { hostId: "host", revision: 0, selection, expectedActorId: aliceId }),
    write(f, "alice", { hostId: "host", revision: 0, selection: { model: "stale", effort: null }, expectedActorId: aliceId }),
  ]);
  const statuses = [one.status, two.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const refused = await (one.status === 409 ? one : two).json();
  assert.equal(refused.error, "revision_conflict");
  assert.equal(refused.revision, 1);
  const winner = await (one.status === 200 ? one : two).json();
  assert.deepEqual(await (await read(f, "alice", "host", aliceId)).json(), winner);

  // Hosts are isolated.
  assert.deepEqual(await (await read(f, "alice", "other-host", aliceId)).json(), { actorId: aliceId, revision: 0, selection: null });

  // Malformed input is rejected without touching the record.
  for (const body of [
    { hostId: "host", revision: 1, selection: null, expectedActorId: aliceId },
    { hostId: "host", revision: 1, selection: { model: "" , effort: null }, expectedActorId: aliceId },
    { hostId: "host", revision: 1, selection: { model: "x", effort: 1 }, expectedActorId: aliceId },
    { hostId: "host", revision: 1, selection: { ...selection, account: "bob" }, expectedActorId: aliceId },
    { hostId: "host", revision: 1, selection: { ...selection, serviceTier: " " }, expectedActorId: aliceId },
    { hostId: "host", revision: -1, selection, expectedActorId: aliceId },
    { hostId: "", revision: 1, selection, expectedActorId: aliceId },
    { hostId: "host", revision: 1, selection, expectedActorId: aliceId, actorId: "human://other" },
  ]) {
    const response = await write(f, "alice", body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await write(f, "alice", { hostId: "host", revision: 1, selection, expectedActorId: aliceId }, { origin: "https://elsewhere.example" })).status, 403);
  assert.deepEqual(await (await read(f, "alice", "host", aliceId)).json(), winner);
});

test("one person never reads or writes another's record, and all their logins share one", async (t) => {
  const f = await routeFixture(t);
  login(f, "alice-local", "alice");
  login(f, "bob", "bob");
  const aliceId = f.actors.resolveHuman(f.principals.get("alice-local")!)!.actorId;
  const bobId = f.actors.resolveHuman(f.principals.get("bob")!)!.actorId;
  f.admitted.add(aliceId).add(bobId);
  assert.equal((await write(f, "alice-local", { hostId: "host", revision: 0, selection, expectedActorId: aliceId })).status, 200);

  // A client naming another Actor only fences its own request; it never selects that record.
  const foreignRead = await read(f, "bob", "host", aliceId);
  assert.equal(foreignRead.status, 409);
  assert.equal((await foreignRead.json()).error, "account_changed");
  assert.equal((await write(f, "bob", { hostId: "host", revision: 1, selection: { model: "hijack", effort: null }, expectedActorId: aliceId })).status, 409);
  assert.deepEqual(await (await read(f, "bob", "host", bobId)).json(), { actorId: bobId, revision: 0, selection: null });
  assert.deepEqual(await (await read(f, "alice-local", "host", aliceId)).json(), { actorId: aliceId, revision: 1, selection });

  // A second verified login bound to the same person reads and advances the same record.
  const oidc = login(f, "alice-oidc", "issuer-subject-digest", "oidc.fixture");
  const aliceContext = f.actors.resolveHuman(f.principals.get("alice-local")!)!;
  assert.equal(f.actors.bindHuman(aliceContext, oidc), true);
  assert.equal(await actorOf(f, "alice-oidc"), aliceId);
  assert.deepEqual(await (await read(f, "alice-oidc", "host", aliceId)).json(), { actorId: aliceId, revision: 1, selection });
  const changed = { model: "from-second-login", effort: null };
  assert.equal((await write(f, "alice-oidc", { hostId: "host", revision: 1, selection: changed, expectedActorId: aliceId })).status, 200);
  assert.deepEqual(await (await read(f, "alice-local", "host", aliceId)).json(), { actorId: aliceId, revision: 2, selection: changed });

  // Revoking admission refuses the person on every login.
  f.admitted.delete(aliceId);
  assert.equal((await read(f, "alice-oidc", "host", aliceId)).status, 403);
  assert.equal((await read(f, "alice-local", "host", aliceId)).status, 403);
});

test("a failed storage owner fails closed with no other read or write path", async (t) => {
  const failing = {
    readAccountModelDefaults: async () => { throw new Error("Server storage failed"); },
    compareAndSetAccountModelDefaults: async () => { throw new Error("Server storage failed"); },
  };
  const f = await routeFixture(t, { storage: failing });
  login(f, "alice", "alice");
  const aliceId = f.actors.resolveHuman(f.principals.get("alice")!)!.actorId;
  f.admitted.add(aliceId);
  const response = await read(f, "alice", "host", aliceId);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "model_defaults_unavailable" });
  assert.equal((await write(f, "alice", { hostId: "host", revision: 0, selection, expectedActorId: aliceId })).status, 503);
  assert.equal(f.storage.database.prepare("SELECT count(*) AS n FROM account_model_defaults").get()?.n, 0);

  // A real owner Worker that has stopped refuses every call the same way.
  const stopped = (await owner(t)).storage;
  await stopped.close();
  const closed = await routeFixture(t, { storage: stopped.call });
  login(closed, "alice", "alice");
  const closedAlice = closed.actors.resolveHuman(closed.principals.get("alice")!)!.actorId;
  closed.admitted.add(closedAlice);
  assert.equal((await read(closed, "alice", "host", closedAlice)).status, 503);
  assert.equal((await write(closed, "alice", { hostId: "host", revision: 0, selection, expectedActorId: closedAlice })).status, 503);
});
