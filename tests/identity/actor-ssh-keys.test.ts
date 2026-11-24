import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import { openServerCoreOwner, type ServerCoreStorage } from "@opencraft/storage-node/server-owner";
import { ActorStore } from "@opencraft/access-control/actors";
import { InstanceAccess, MembershipStore } from "@opencraft/access-control";
import type { Principal } from "@opencraft/identity-core";
import { parsePersonalPublicKey } from "@opencraft/ssh-http-ingress/keys";
import { createSshHttpIngress } from "../../plugins/ssh-http-ingress/src/index.mjs";
import {
  ActorSshKeys,
  ActorSshKeyRefusal,
  composeSshAccess,
  installationSshKeyAuthority,
  sshKeyOperator,
} from "../../apps/headless-server/src/actor-ssh-keys.ts";
import { ACTOR_SSH_KEYS_PATH, actorSshKeysHttp } from "../../apps/headless-server/src/actor-ssh-keys-http.ts";
import { humanActorAccess } from "../../apps/headless-server/src/account-model-defaults-http.ts";
import { importActorSshKeys, parseSshKeyImport } from "../../apps/headless-server/src/actor-ssh-key-import.ts";
import { generateEd25519KeyPair } from "../support/ssh-ed25519.mjs";

const blobOf = (publicKey: string) => Buffer.from(publicKey.split(" ")[1]!, "base64");
const principal = (subject: string): Principal => ({
  provider: "local",
  subject,
  displayName: subject,
  expiresAt: Date.now() + 600_000,
});

interface Fixture {
  readonly directory: string;
  readonly storage: ServerCoreStorage;
  readonly actors: ActorStore;
  readonly members: MembershipStore;
  readonly access: InstanceAccess;
  readonly keys: ActorSshKeys;
  human(subject: string, role?: "admin" | "member"): string;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "actor-ssh-keys-"));
  const storage = await openServerCoreOwner(directory);
  const actors = new ActorStore(storage);
  const members = new MembershipStore(storage);
  const access = new InstanceAccess(members, [], actors);
  const keys = await ActorSshKeys.open(storage.call, installationSshKeyAuthority({ actors, access }));
  storage.onUnavailable((error) => keys.fail(error));
  t.after(async () => {
    keys.close();
    members.close();
    actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    storage,
    actors,
    members,
    access,
    keys,
    human(subject, role = "member") {
      const context = actors.resolveHuman(principal(subject))!;
      members.setActor(context.actorId, role, true, "test");
      return context.actorId;
    },
  };
}

/** Lets fire-and-forget revocations reach the owner Worker and return. */
const settle = (storage: ServerCoreStorage) => storage.call.actorSshKeyAudit(null, 1);

test("public keys are parsed, normalized and fingerprinted; private, weak and malformed keys are refused", () => {
  const ed = generateEd25519KeyPair();
  const parsed = parsePersonalPublicKey(`  ${ed.public}  me@laptop \n`);
  assert.ok(parsed);
  assert.equal(parsed.algorithm, "ssh-ed25519");
  assert.equal(parsed.publicKey, ed.public);
  assert.equal(parsed.comment, "me@laptop");
  assert.match(parsed.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/u);
  const rsa = (modulusLength: number) => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    return "ssh-rsa " + (ssh2.utils.parseKey(privateKey) as ssh2.ParsedKey).getPublicSSH().toString("base64");
  };
  assert.equal(parsePersonalPublicKey(rsa(2048))?.algorithm, "ssh-rsa");
  assert.equal(parsePersonalPublicKey(rsa(1024)), null, "RSA below 2048 bits");
  for (const value of [
    ed.private,
    `${ed.public}\n${ed.public}`,
    "ssh-dss AAAAB3NzaC1kc3MAAACBAP",
    `ssh-rsa ${ed.public.split(" ")[1]}`,
    `ssh-ed25519 ${ed.public.split(" ")[1]!.slice(0, -4)}`,
    `command="x" ${ed.public}`,
    "",
    42,
    "x".repeat(20_000),
  ])
    assert.equal(parsePersonalPublicKey(value), null, String(value).slice(0, 40));
});

test("people add, list and remove their own keys; every change and refusal is audited", async (t) => {
  const f = await fixture(t);
  const alice = f.human("alice"),
    bob = f.human("bob");
  const laptop = generateEd25519KeyPair(),
    desktop = generateEd25519KeyPair();
  const added = await f.keys.add(
    alice,
    { name: "Laptop", publicKey: laptop.public + " alice@laptop" },
    sshKeyOperator.self(alice),
  );
  assert.deepEqual(
    { name: added.name, algorithm: added.algorithm, addedBy: added.addedBy },
    { name: "Laptop", algorithm: "ssh-ed25519", addedBy: "self" },
  );
  const named = await f.keys.add(alice, { publicKey: desktop.public + " desk" }, sshKeyOperator.administrator(bob));
  assert.equal(named.name, "desk", "the key comment names a key without a name");
  assert.equal(named.addedBy, "administrator");
  assert.deepEqual(
    f.keys.list(alice).map((key) => key.id),
    [added.id, named.id],
  );
  assert.deepEqual(f.keys.list(bob), []);

  // The same public key is refused for the same person and for anyone else.
  await assert.rejects(f.keys.add(alice, { name: "Again", publicKey: laptop.public }, sshKeyOperator.self(alice)), {
    code: "key_exists",
  });
  await assert.rejects(f.keys.add(bob, { name: "Stolen", publicKey: laptop.public }, sshKeyOperator.self(bob)), {
    code: "key_in_use",
  });
  await assert.rejects(f.keys.add(bob, { name: "Bad", publicKey: "ssh-ed25519 AAAA" }, sshKeyOperator.self(bob)), {
    code: "invalid_ssh_key",
  });
  await assert.rejects(
    f.keys.add(bob, { name: " ", publicKey: generateEd25519KeyPair().public }, sshKeyOperator.self(bob)),
    { code: "invalid_key_name" },
  );
  // A person cannot remove another person's key by id.
  await assert.rejects(f.keys.remove(bob, added.id, sshKeyOperator.self(bob)), { code: "unknown_key" });

  await f.keys.remove(alice, added.id, sshKeyOperator.self(alice));
  assert.deepEqual(
    f.keys.list(alice).map((key) => key.id),
    [named.id],
  );
  // A removed key's fingerprint may be registered again, by anyone.
  const reused = await f.keys.add(bob, { name: "Reused", publicKey: laptop.public }, sshKeyOperator.self(bob));
  assert.deepEqual(
    f.keys.list(bob).map((key) => key.id),
    [reused.id],
  );

  const audit = await f.storage.call.actorSshKeyAudit(null, 50);
  assert.deepEqual(
    audit.map((entry) => [entry.action, entry.result, entry.operator]).reverse(),
    [
      ["add", "ok", sshKeyOperator.self(alice)],
      ["add", "ok", sshKeyOperator.administrator(bob)],
      ["add", "key_exists", sshKeyOperator.self(alice)],
      ["add", "key_in_use", sshKeyOperator.self(bob)],
      ["remove", "ok", sshKeyOperator.self(alice)],
      ["add", "ok", sshKeyOperator.self(bob)],
    ],
    "refusals the owner saw are audited; input refused before storage never reaches it",
  );
  assert.ok(
    audit.every((entry) => !JSON.stringify(entry).includes(laptop.public.split(" ")[1]!)),
    "the audit holds fingerprints, never key material",
  );
  const history = await f.storage.call.actorSshKeyHistory(alice);
  assert.equal(history.find((key) => key.id === added.id)?.revokedReason, "removed");

  // The projection survives a restart from committed rows only.
  const reopened = await ActorSshKeys.open(
    f.storage.call,
    installationSshKeyAuthority({ actors: f.actors, access: f.access }),
  );
  t.after(() => reopened.close());
  assert.deepEqual(reopened.list(alice), f.keys.list(alice));
  assert.deepEqual(reopened.list(bob), f.keys.list(bob));
});

test("the owner refuses duplicate active fingerprints under concurrency and enforces the per-person limit", async (t) => {
  const f = await fixture(t);
  const alice = f.human("alice"),
    bob = f.human("bob");
  const shared = generateEd25519KeyPair().public;
  const results = await Promise.allSettled([
    f.keys.add(alice, { name: "a", publicKey: shared }, sshKeyOperator.self(alice)),
    f.keys.add(bob, { name: "b", publicKey: shared }, sshKeyOperator.self(bob)),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(
    (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.code,
    "key_in_use",
  );
  for (let index = f.keys.list(alice).length; index < 32; index++)
    await f.keys.add(
      alice,
      { name: "k" + index, publicKey: generateEd25519KeyPair().public },
      sshKeyOperator.self(alice),
    );
  await assert.rejects(
    f.keys.add(alice, { name: "over", publicKey: generateEd25519KeyPair().public }, sshKeyOperator.self(alice)),
    { code: "key_limit" },
  );
});

test("SSH authentication resolves the key's Actor; disabled or revoked people are refused and their keys revoked", async (t) => {
  const f = await fixture(t);
  const alice = f.human("alice"),
    bob = f.human("bob"),
    carol = f.human("carol");
  const aliceKey = generateEd25519KeyPair(),
    bobKey = generateEd25519KeyPair(),
    carolKey = generateEd25519KeyPair();
  await f.keys.add(alice, { name: "a", publicKey: aliceKey.public }, sshKeyOperator.self(alice));
  await f.keys.add(bob, { name: "b", publicKey: bobKey.public }, sshKeyOperator.self(bob));
  await f.keys.add(carol, { name: "c", publicKey: carolKey.public }, sshKeyOperator.self(carol));

  // The user name is not significant; the offered key selects the person.
  assert.deepEqual(f.keys.publicKeys("anyone", blobOf(aliceKey.public)), [aliceKey.public]);
  assert.deepEqual(f.keys.publicKeys("anyone"), [], "nothing is listed without an offered key");
  assert.deepEqual(f.keys.publicKeys("anyone", blobOf(generateEd25519KeyPair().public)), []);
  const session = f.keys.authorize("opencraft", blobOf(aliceKey.public))!;
  assert.ok(session);
  assert.equal(session.submissionContext.actorContext?.actorId, alice);
  assert.equal(session.submissionContext.actorContext?.credentialId, null);
  assert.deepEqual(session.submissionContext.executionPrincipal, { provider: "local", subject: "alice" });
  assert.deepEqual(session.submissionContext.tokenUsageAuthority?.(), { actorId: alice, administrator: false });
  assert.equal(session.isCurrent(), true);
  assert.equal(f.keys.authorize("opencraft", blobOf(bobKey.public))?.submissionContext.actorContext?.actorId, bob);

  // Disabling the Actor refuses login at once and durably revokes the key.
  f.actors.setEnabled(alice, false, "test");
  assert.equal(session.isCurrent(), false, "an established session loses its authority");
  assert.throws(() => session.submissionContext.resourceOwner!.assertCurrent(), /revoked/);
  assert.equal(f.keys.authorize("opencraft", blobOf(aliceKey.public)), null);
  assert.deepEqual(f.keys.list(alice), []);
  await settle(f.storage);
  // Re-enabling does not revive the key; the person registers it again.
  f.actors.setEnabled(alice, true, "test");
  assert.equal(f.keys.authorize("opencraft", blobOf(aliceKey.public)), null);
  assert.equal((await f.storage.call.actorSshKeyHistory(alice))[0]?.revokedReason, "actor-disabled");

  // An explicit membership revocation revokes too; re-granting does not revive.
  const bobSession = f.keys.authorize("opencraft", blobOf(bobKey.public))!;
  f.members.setActor(bob, "member", false, "test");
  assert.equal(bobSession.isCurrent(), false);
  assert.deepEqual(f.keys.publicKeys("x", blobOf(bobKey.public)), []);
  await settle(f.storage);
  f.members.setActor(bob, "member", true, "test");
  assert.equal(f.keys.authorize("opencraft", blobOf(bobKey.public)), null);
  assert.equal((await f.storage.call.actorSshKeyHistory(bob))[0]?.revokedReason, "membership-revoked");
  const audit = await f.storage.call.actorSshKeyAudit(null, 20);
  assert.ok(
    audit.some(
      (entry) => entry.actorId === alice && entry.action === "revoke:actor-disabled" && entry.operator === "system",
    ),
  );
  assert.ok(audit.some((entry) => entry.actorId === bob && entry.action === "revoke:membership-revoked"));

  // A person who simply lacks admission is refused without losing keys.
  const unadmitted = await ActorSshKeys.open(
    f.storage.call,
    installationSshKeyAuthority({
      actors: f.actors,
      access: { admitsActor: () => false, store: f.members },
    }),
  );
  t.after(() => unadmitted.close());
  assert.equal(unadmitted.authorize("opencraft", blobOf(carolKey.public)), null);
  assert.equal(f.keys.authorize("opencraft", blobOf(carolKey.public))?.submissionContext.actorContext?.actorId, carol);

  // A key whose Actor was disabled while the server was stopped is revoked when it opens.
  f.keys.close();
  unadmitted.close();
  f.actors.setEnabled(carol, false, "offline");
  f.actors.setEnabled(carol, true, "offline");
  const restarted = await ActorSshKeys.open(f.storage.call, {
    ...installationSshKeyAuthority({ actors: f.actors, access: f.access }),
    subscribe: () => () => {},
  });
  t.after(() => restarted.close());
  assert.equal(restarted.authorize("opencraft", blobOf(carolKey.public)), null);
  await settle(f.storage);
  assert.equal((await f.storage.call.actorSshKeyHistory(carol))[0]?.revokedReason, "actor-generation");
});

test("a lost owner Worker fences every key; nothing falls back to this thread", async (t) => {
  const f = await fixture(t);
  const alice = f.human("alice");
  const key = generateEd25519KeyPair();
  await f.keys.add(alice, { name: "a", publicKey: key.public }, sshKeyOperator.self(alice));
  assert.ok(f.keys.authorize("u", blobOf(key.public)));
  f.keys.fail(new Error("owner lost"));
  assert.equal(f.keys.authorize("u", blobOf(key.public)), null);
  assert.deepEqual(f.keys.publicKeys("u", blobOf(key.public)), []);
  assert.throws(() => f.keys.list(alice), ActorSshKeyRefusal);
  await assert.rejects(f.keys.add(alice, { name: "b", publicKey: generateEd25519KeyPair().public }, "x"), {
    code: "ssh_keys_unavailable",
  });
});

test(
  "a real SSH login with a personal key carries that person's Actor and ends when the key is removed",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const alice = f.human("alice");
    const host = generateEd25519KeyPair(),
      personal = generateEd25519KeyPair(),
      stranger = generateEd25519KeyPair();
    const added = await f.keys.add(alice, { name: "a", publicKey: personal.public }, sshKeyOperator.self(alice));
    const http = createServer((_request, response) => response.end("legacy"));
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const sessions: unknown[] = [];
    const access = composeSshAccess(null, f.keys)!;
    const ingress = createSshHttpIngress({
      hostKey: host.private,
      authorizedKeys: { operator: [host.public] },
      httpPort: (http.address() as AddressInfo).port,
      resolveAuthorizedKeys: (username: string, key: Buffer) => access.publicKeys(username, key),
      authorizeSession: (username: string, key: Buffer) => {
        const authorization = access.authorize(username, key);
        sessions.push(authorization?.submissionContext.actorContext?.actorId ?? null);
        return authorization;
      },
      createNativeSession: async () => ({
        port: 1,
        connect: () => {
          throw new Error("not used");
        },
        close: async () => {},
      }),
    });
    const address = await ingress.listen({ port: 0 });
    const clients: ssh2.Client[] = [];
    t.after(async () => {
      for (const client of clients) client.destroy();
      await ingress.close();
      http.close();
    });
    const connect = (privateKey: string, username = "opencraft") => {
      const client = new ssh2.Client();
      client.on("error", () => {});
      clients.push(client);
      const ready = new Promise<ssh2.Client>((resolve, reject) => {
        client.once("ready", () => resolve(client));
        client.once("error", reject);
      });
      client.connect({ host: "127.0.0.1", port: address.port, username, privateKey, readyTimeout: 2000 });
      return ready;
    };
    await assert.rejects(connect(stranger.private), /authentication/);
    const client = await connect(personal.private, "any-name");
    assert.deepEqual(sessions, [alice]);
    const closed = once(client, "close");
    await f.keys.remove(alice, added.id, sshKeyOperator.self(alice));
    await closed;
    await assert.rejects(connect(personal.private), /authentication/);
  },
);

test("an identity composition's own SSH access is consulted first", () => {
  const offered = Buffer.from("k");
  const identity = {
    publicKeys: () => ["identity-key"],
    authorize: () => ({ submissionContext: { sender: null }, isCurrent: () => true }),
  };
  const personal = { publicKeys: () => ["personal-key"], authorize: () => null };
  const access = composeSshAccess(identity, personal)!;
  assert.deepEqual(access.publicKeys("u", offered), ["identity-key", "personal-key"]);
  assert.equal(access.authorize("u", offered)?.submissionContext.sender, null);
  assert.equal(composeSshAccess(null, null), null);
  assert.equal(composeSshAccess(identity, null), identity);
});

interface RouteFixture extends Fixture {
  readonly url: string;
  login(token: string, subject: string): void;
}

async function route(t: test.TestContext): Promise<RouteFixture> {
  const f = await fixture(t);
  const principals = new Map<string, Principal>();
  const authenticate = (request: IncomingMessage) => {
    const token = request.headers["x-fixture-login"];
    const value = typeof token === "string" ? principals.get(token) : undefined;
    const actor = value ? f.actors.findHuman(value) : null;
    return actor
      ? { actorId: actor.id, generation: actor.generation, credentialId: null, expiresAt: Date.now() + 60_000 }
      : null;
  };
  const authority = installationSshKeyAuthority({ actors: f.actors, access: f.access });
  const handler = actorSshKeysHttp(f.keys, {
    access: humanActorAccess({
      authenticate,
      isCurrentHuman: (context) => f.actors.isCurrent(context) && f.actors.get(context.actorId)?.kind === "human",
      admits: (actorId) => f.access.admitsActor(actorId),
      trustedOrigin: () => null,
    }),
    administrator: (_request, actorId) => authority.administrator(actorId),
    isHuman: (actorId) => f.actors.get(actorId)?.kind === "human",
    sshLogin: true,
  });
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
  t.after(() => server.close());
  return {
    ...f,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    login: (token, subject) => principals.set(token, principal(subject)),
  };
}

test("the HTTP route serves the signed-in person's keys; administrators may manage another person's", async (t) => {
  const f = await route(t);
  const alice = f.human("alice"),
    bob = f.human("bob"),
    admin = f.human("admin", "admin");
  f.login("alice", "alice");
  f.login("bob", "bob");
  f.login("admin", "admin");
  const get = (token: string, actorId?: string) =>
    fetch(f.url + ACTOR_SSH_KEYS_PATH + (actorId ? "?" + new URLSearchParams({ actorId }) : ""), {
      headers: { "x-fixture-login": token },
    });
  const post = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(f.url + ACTOR_SSH_KEYS_PATH, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "x-fixture-login": token, origin: f.url, "content-type": "application/json", ...headers },
    });
  const remove = (token: string, keyId: string, expectedActorId: string, actorId?: string) =>
    fetch(
      `${f.url}${ACTOR_SSH_KEYS_PATH}/${keyId}?${new URLSearchParams({ expectedActorId, ...(actorId ? { actorId } : {}) })}`,
      { method: "DELETE", headers: { "x-fixture-login": token, origin: f.url } },
    );

  assert.equal((await get("nobody")).status, 401);
  assert.deepEqual(await (await get("alice")).json(), {
    actorId: alice,
    subjectActorId: alice,
    administrator: false,
    sshLogin: true,
    keys: [],
  });
  const key = generateEd25519KeyPair().public;
  const created = await post("alice", { publicKey: key, name: "Laptop", expectedActorId: alice });
  assert.equal(created.status, 201);
  const { key: view } = (await created.json()) as { key: { id: string; fingerprint: string; name: string } };
  assert.equal(view.name, "Laptop");
  assert.ok(!JSON.stringify(view).includes(key.split(" ")[1]!), "responses never echo the key body");
  assert.equal((await post("bob", { publicKey: key, expectedActorId: bob })).status, 409);
  assert.equal(
    (await post("alice", { publicKey: generateEd25519KeyPair().public, expectedActorId: bob })).status,
    409,
    "account fence",
  );
  assert.equal((await post("alice", { publicKey: "nope", expectedActorId: alice })).status, 400);
  assert.equal(
    (
      await post(
        "alice",
        { publicKey: generateEd25519KeyPair().public, expectedActorId: alice },
        { origin: "https://elsewhere.example" },
      )
    ).status,
    403,
  );
  // Ordinary people cannot read or change another person's keys.
  assert.equal((await get("bob", alice)).status, 403);
  assert.equal(
    (await post("bob", { publicKey: generateEd25519KeyPair().public, expectedActorId: bob, actorId: alice })).status,
    403,
  );
  assert.equal((await remove("bob", view.id, bob)).status, 404);
  assert.equal((await remove("bob", view.id, bob, alice)).status, 403);
  // An administrator lists, adds and removes for another Human.
  const listed = (await (await get("admin", alice)).json()) as { keys: { id: string }[]; administrator: boolean };
  assert.equal(listed.administrator, true);
  assert.deepEqual(
    listed.keys.map((entry) => entry.id),
    [view.id],
  );
  const adminAdded = await post("admin", {
    publicKey: generateEd25519KeyPair().public,
    name: "Issued",
    expectedActorId: admin,
    actorId: alice,
  });
  assert.equal(adminAdded.status, 201);
  assert.equal(((await adminAdded.json()) as { key: { addedBy: string } }).key.addedBy, "administrator");
  assert.equal((await remove("admin", view.id, admin, alice)).status, 204);
  assert.equal((await remove("alice", view.id, alice)).status, 404);
  assert.equal(((await (await get("alice")).json()) as { keys: unknown[] }).keys.length, 1);
  // Losing admission refuses the route.
  f.members.setActor(alice, "member", false, "test");
  assert.equal((await get("alice")).status, 403);
});

test("an existing per-person key store is adopted through an idempotent import", async (t) => {
  const f = await fixture(t);
  const alice = f.human("alice"),
    bob = f.human("bob");
  const a = generateEd25519KeyPair().public,
    b = generateEd25519KeyPair().public,
    c = generateEd25519KeyPair().public;
  const aliceGeneration = f.actors.get(alice)!.generation;
  const document = parseSshKeyImport({
    format: 1,
    source: "previous-store",
    keys: [
      {
        actorId: alice,
        name: "laptop",
        publicKey: a + " alice@laptop",
        createdAt: 1_700_000_000_000,
        actorGeneration: aliceGeneration,
      },
      { binding: { provider: "local", subject: "bob" }, publicKey: b },
      { actorId: bob, name: "dup", publicKey: a },
      { actorId: "human://missing/1", publicKey: c },
      { actorId: alice, publicKey: c, actorGeneration: aliceGeneration + 5 },
      { actorId: alice, publicKey: "ssh-ed25519 AAAA" },
    ],
  });
  const options = {
    resolveActor: (entry: { actorId?: string; binding?: { provider: string; subject: string } }) =>
      entry.actorId ? (f.actors.get(entry.actorId)?.id ?? null) : (f.actors.findHuman(entry.binding!)?.id ?? null),
    generation: (actorId: string) => f.actors.get(actorId)?.generation ?? null,
  };
  const dry = await importActorSshKeys(f.keys, document, { ...options, dryRun: true });
  assert.deepEqual(
    dry.map((result) => result.outcome),
    ["would-import", "would-import", "would-import", "unknown-actor", "stale-generation", "invalid_ssh_key"],
  );
  assert.deepEqual(f.keys.list(alice), []);
  const first = await importActorSshKeys(f.keys, document, options);
  assert.deepEqual(
    first.map((result) => result.outcome),
    ["imported", "imported", "key_in_use", "unknown-actor", "stale-generation", "invalid_ssh_key"],
  );
  const [imported] = f.keys.list(alice);
  assert.equal(imported?.name, "laptop");
  assert.equal(imported?.createdAt, 1_700_000_000_000);
  assert.equal(imported?.addedBy, "import");
  assert.equal(f.keys.list(bob)[0]?.fingerprint, parsePersonalPublicKey(b)!.fingerprint);
  const second = await importActorSshKeys(f.keys, document, options);
  assert.deepEqual(second.map((result) => result.outcome).slice(0, 3), [
    "already-present",
    "already-present",
    "key_in_use",
  ]);
  const audit = await f.storage.call.actorSshKeyAudit(alice, 10);
  assert.ok(
    audit.some(
      (entry) => entry.action === "import" && entry.operator === "import:previous-store" && entry.result === "ok",
    ),
  );
  for (const invalid of [
    { format: 2, source: "x", keys: [] },
    { format: 1, source: "bad source", keys: [] },
    { format: 1, source: "x", keys: [{ publicKey: a }] },
    { format: 1, source: "x", keys: [{ actorId: alice, binding: { provider: "p", subject: "s" }, publicKey: a }] },
    { format: 1, source: "x", keys: [{ actorId: alice, publicKey: a, privateKey: "secret" }] },
  ])
    assert.throws(() => parseSshKeyImport(invalid), /Invalid SSH key import/);
});

test("SSH logins keep answering from the projection while a key write waits for the writer lock", async (t) => {
  const f = await fixture(t);
  const alice = f.human("alice");
  const existing = generateEd25519KeyPair();
  await f.keys.add(alice, { name: "a", publicKey: existing.public }, sshKeyOperator.self(alice));
  let settled = false;
  f.storage.database.exec("BEGIN IMMEDIATE");
  const pending = f.keys
    .add(alice, { name: "b", publicKey: generateEd25519KeyPair().public }, sshKeyOperator.self(alice))
    .finally(() => {
      settled = true;
    });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false);
    assert.equal(f.keys.authorize("u", blobOf(existing.public))?.submissionContext.actorContext?.actorId, alice);
    assert.equal(f.keys.list(alice).length, 1, "a key appears only after its commit");
  } finally {
    f.storage.database.exec("ROLLBACK");
  }
  await pending;
  assert.equal(f.keys.list(alice).length, 2);
});

test("the registration parser accepts exactly what the ingress verifier parses, for every algorithm", () => {
  const keys: string[] = [generateEd25519KeyPair().public];
  for (const namedCurve of ["prime256v1", "secp384r1", "secp521r1"]) {
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve,
      privateKeyEncoding: { type: "sec1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const parsed = ssh2.utils.parseKey(privateKey) as ssh2.ParsedKey;
    keys.push(parsed.type + " " + parsed.getPublicSSH().toString("base64"));
  }
  for (const key of keys) {
    const ours = parsePersonalPublicKey(key);
    const theirs = ssh2.utils.parseKey(key) as ssh2.ParsedKey;
    assert.ok(ours, key.slice(0, 30));
    assert.equal(ours.algorithm, theirs.type);
    assert.equal(ours.publicKey, key);
    // A point that is not on the curve is refused even though its shape is right.
    const blob = Buffer.from(key.split(" ")[1]!, "base64");
    blob[blob.length - 1] ^= 1;
    if (theirs.type.startsWith("ecdsa"))
      assert.equal(parsePersonalPublicKey(theirs.type + " " + blob.toString("base64")), null);
  }
});
