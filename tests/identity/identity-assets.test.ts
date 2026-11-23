import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { InstanceAccess, MembershipStore } from "@opencraft/access-control";
import { WorkspaceActorAuthority } from "@opencraft/access-control/actor-admission-reader";
import { openIdentityAssets, type IdentityAssetsPort } from "../../plugins/assets/src/server/identity-assets.js";
import { openHeadlessAssetsStorage } from "../../apps/headless-server/src/headless-assets-storage.js";

const PROVIDER = "fixture-sso";
const SECRET = "synthetic-identity-assets-secret-value";
const PLAIN = "synthetic-plain-region";

/** A composition with its own login provider (not HumanAuth) and the headless
 * vault Worker. Logins live in a map; a cookie names one. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "identity-assets-")),
    directory = join(root, "data");
  const storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    members = new MembershipStore(storage),
    access = new InstanceAccess(members, [], actors);
  const principal = {
    provider: PROVIDER,
    subject: "person-1",
    displayName: "Fixture",
    expiresAt: Date.now() + 3_600_000,
  };
  const actorId = actors.resolveHuman(principal)!.actorId;
  members.setActor(actorId, "member", true, "fixture");
  const logins = new Map([["login-1", { principal, valid: true }]]);
  const listeners = new Set<() => void>();
  const owner = await openHeadlessAssetsStorage(directory, { environmentLaunch: true });
  assert.equal(owner.environmentSettings, true);
  await owner.environmentMetadata!.rememberProjects("local-codex", [{ id: "alpha", name: "Alpha" }]);
  // Everything the Worker hands Main, to prove no secret value reaches it.
  const seen: unknown[] = [];
  const recorded = new Proxy(owner.store, {
    get(target, name) {
      const method = (target as unknown as Record<string | symbol, unknown>)[name];
      return typeof method !== "function"
        ? method
        : async (...args: unknown[]) => {
            const value = await (method as (...a: unknown[]) => Promise<unknown>)(...args);
            seen.push(value);
            return value;
          };
    },
  }) as IdentityAssetsPort;
  let origin = "";
  const service = openIdentityAssets({
    port: recorded,
    origin: () => origin,
    actors,
    membership: members,
    access,
    provider: PROVIDER,
    gitHosts: owner.gitHosts,
    gitProviders: owner.gitProviders,
    environment: owner.environmentSettings,
    resolveRequest(request: IncomingMessage) {
      const token = /(?:^|;\s*)fixture_sso=([^;]+)/u.exec(request.headers.cookie ?? "")?.[1];
      const login = token ? logins.get(token) : undefined;
      if (!login?.valid) return null;
      return {
        principal: login.principal,
        current: () => login.valid,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  });
  const server = createServer((request, response) => {
    void service.handle(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    service.close();
    await owner.close();
    members.close();
    actors.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  const scope = `actor:${actorId}`;
  const headers = {
    cookie: "fixture_sso=login-1",
    "x-opencraft-account-scope": scope,
    origin,
    "content-type": "application/json",
  };
  const request = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(origin + path, {
      headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  const logout = () => {
    logins.get("login-1")!.valid = false;
    for (const listener of listeners) listener();
  };
  return { directory, storage, actors, members, owner, actorId, scope, request, logout, seen, service };
}

test("a non-HumanAuth principal is served end to end through the vault Worker", async (t) => {
  const f = await fixture(t);
  const status = await (await f.request("/__opencraft_assets/status")).json();
  assert.equal(status.scope, f.scope);
  assert.equal(status.environment, true);
  assert.deepEqual(status.gitHosts, ["github.com"]);
  const snapshot = await (await f.request("/__opencraft_assets/configurations")).json();
  assert.equal(snapshot.scope, f.scope);
  assert.equal(snapshot.allowCustomEndpoints, false);
  const saved = await f.request("/__opencraft_assets/configurations", {
    action: "save-credential",
    revision: 0,
    name: "E2B",
    apiUrl: "https://api.e2b.dev",
    sandboxUrl: "https://e2b.dev",
    apiKey: SECRET,
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
  const git = await (await f.request("/__opencraft_assets/git-connections")).json();
  assert.equal(git.scope, f.scope);
  // Another person's scope, a bearer credential and a foreign provider grant nothing.
  assert.equal(
    (
      await f.request("/__opencraft_assets/configurations", undefined, {
        "x-opencraft-account-scope": "actor:human://x/y",
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request("/__opencraft_assets/configurations", undefined, { authorization: "Bearer synthetic" })).status,
    403,
  );
  assert.equal((await (await f.request("/__opencraft_assets/status", undefined, { cookie: "" })).json()).scope, null);
  f.logout();
  assert.equal((await f.request("/__opencraft_assets/configurations")).status, 403);
  assert.equal((await f.request("/__opencraft_assets/environment")).status, 401);
  assert.ok(!JSON.stringify(f.seen).includes(SECRET));
});

test("the Worker projects the committed role: custom endpoints follow an administrator membership", async (t) => {
  const f = await fixture(t);
  assert.equal((await (await f.request("/__opencraft_assets/configurations")).json()).canManagePlatform, false);
  f.members.setActor(f.actorId, "admin", true, "fixture");
  const admin = await (await f.request("/__opencraft_assets/configurations")).json();
  assert.equal(admin.allowCustomEndpoints, true);
  assert.equal(admin.canManagePlatform, true);
  f.members.setActor(f.actorId, "member", true, "fixture");
  const platform = await f.request("/__opencraft_assets/configurations", {
    action: "save-credential",
    source: "platform",
    revision: 0,
    name: "Shared",
    apiUrl: "https://api.e2b.dev",
    sandboxUrl: "https://e2b.dev",
    apiKey: SECRET,
  });
  assert.equal(platform.status, 403);
});

test("committed role projection: Actor membership wins, then administrator bindings, else member", async (t) => {
  const f = await fixture(t);
  const reader = new WorkspaceActorAuthority(f.directory);
  t.after(() => reader.close());
  const proof = {
    actorId: f.actorId,
    generation: f.actors.get(f.actorId)!.generation,
    membershipRevision: f.members.revocationRevision(f.actorId, f.actors.bindings(f.actorId)),
    expiresAt: Date.now() + 60_000,
    resourcePermit: new Int32Array(new SharedArrayBuffer(4)).fill(1),
    requestPermit: new Int32Array(new SharedArrayBuffer(4)).fill(1),
  };
  assert.equal(reader.current(proof, true), true);
  assert.equal(reader.role(f.actorId), "member");
  f.members.setActor(f.actorId, "admin", true, "fixture");
  assert.equal(reader.role(f.actorId), "admin");
  assert.equal(reader.administrator(f.actorId), true);
  f.members.setActor(f.actorId, "member", false, "fixture");
  assert.equal(reader.current(proof, true), false);
  assert.equal(reader.role(f.actorId), null);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(f.directory, "opencraft-server.sqlite"));
  try {
    db.prepare("DELETE FROM actor_members WHERE actor_id=?").run(f.actorId);
  } finally {
    db.close();
  }
  assert.equal(reader.role(f.actorId), "member");
  f.members.set({ provider: PROVIDER, subject: "person-1" }, "admin", true, "fixture");
  assert.equal(reader.role(f.actorId), "admin");
});

test("personal ENV: list, replace, projects, stale revision and validation, with write-only secrets", async (t) => {
  const f = await fixture(t);
  const listed = await f.request("/__opencraft_assets/environment");
  assert.equal(listed.status, 200);
  const empty = await listed.json();
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.variables, []);
  assert.equal(empty.projects.length, 1);
  const project = empty.projects[0];
  assert.equal(project.name, "Alpha");
  const saved = await f.request("/__opencraft_assets/environment", {
    projectId: null,
    revision: 0,
    variables: [
      { name: "SERVICE_TOKEN", value: SECRET, secret: true },
      { name: "REGION", value: PLAIN, secret: false },
    ],
  });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.revision, 1);
  assert.deepEqual(body.variables, [
    { name: "SERVICE_TOKEN", value: null, secret: true },
    { name: "REGION", value: PLAIN, secret: false },
  ]);
  // A stale revision is a conflict; nothing is overwritten.
  const stale = await f.request("/__opencraft_assets/environment", { projectId: null, revision: 0, variables: [] });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "conflict");
  // The project scope inherits the personal default; an unknown project is refused.
  const scoped = await (
    await f.request(`/__opencraft_assets/environment?projectId=${encodeURIComponent(project.id)}`)
  ).json();
  assert.equal(scoped.projectId, project.id);
  assert.deepEqual(
    scoped.inherited.map((v: { name: string }) => v.name),
    ["SERVICE_TOKEN", "REGION"],
  );
  assert.equal((await f.request("/__opencraft_assets/environment?projectId=unknown")).status, 400);
  const reserved = await f.request("/__opencraft_assets/environment", {
    projectId: null,
    revision: 1,
    variables: [{ name: "PATH", value: "/tmp", secret: false }],
  });
  assert.equal((await reserved.json()).error, "reserved");
  // Retaining a saved secret sends null; its value is never read back.
  const kept = await f.request("/__opencraft_assets/environment", {
    projectId: null,
    revision: 1,
    variables: [{ name: "SERVICE_TOKEN", value: null, secret: true }],
  });
  assert.equal((await kept.json()).revision, 2);
  assert.equal(
    (await f.request("/__opencraft_assets/environment", undefined, { origin: "https://attacker.invalid" })).status,
    403,
  );
  assert.ok(!JSON.stringify(f.seen).includes(SECRET), "no Worker answer to Main carries a secret value");
  assert.ok(!(await readFile(join(f.directory, "employee-git-vault.sqlite"))).includes(Buffer.from(SECRET)));
});

for (const revocation of ["actor", "member"] as const)
  test(`a revoked ${revocation} is refused by Main and, independently, by the Worker`, async (t) => {
    const f = await fixture(t);
    // A proof whose permits Main never retires: only committed records can refuse it.
    const proof = {
      actorId: f.actorId,
      generation: f.actors.get(f.actorId)!.generation,
      membershipRevision: f.members.revocationRevision(f.actorId, f.actors.bindings(f.actorId)),
      expiresAt: Date.now() + 60_000,
      resourcePermit: new Int32Array(new SharedArrayBuffer(4)).fill(1),
      requestPermit: new Int32Array(new SharedArrayBuffer(4)).fill(1),
    };
    assert.equal((await f.owner.store.environmentList(proof, { projectId: null })).revision, 0);
    if (revocation === "actor") f.actors.setEnabled(f.actorId, false, "fixture");
    else f.members.setActor(f.actorId, "member", false, "fixture");
    await assert.rejects(f.owner.store.environmentList(proof, { projectId: null }), { code: "forbidden" });
    await assert.rejects(
      f.owner.store.environmentReplace(proof, { projectId: null }, 0, [{ name: "A", value: "b", secret: false }]),
      { code: "forbidden" },
    );
    await assert.rejects(f.owner.store.environmentProjects(proof), { code: "forbidden" });
    await assert.rejects(f.owner.store.actorConfigurationsSnapshot(proof), { code: "forbidden" });
    const response = await f.request("/__opencraft_assets/environment", {
      projectId: null,
      revision: 0,
      variables: [{ name: "A", value: "b", secret: false }],
    });
    assert.equal(response.status, 401);
    assert.equal((await f.request("/__opencraft_assets/status").then((r) => r.json())).scope, null);
  });

test("a retired request permit fences the Worker before its ENV write", async (t) => {
  const f = await fixture(t);
  const proof = {
    actorId: f.actorId,
    generation: f.actors.get(f.actorId)!.generation,
    membershipRevision: f.members.revocationRevision(f.actorId, f.actors.bindings(f.actorId)),
    expiresAt: Date.now() + 60_000,
    resourcePermit: new Int32Array(new SharedArrayBuffer(4)).fill(1),
    requestPermit: new Int32Array(new SharedArrayBuffer(4)).fill(1),
  };
  Atomics.store(proof.requestPermit, 0, 0);
  await assert.rejects(
    f.owner.store.environmentReplace(proof, { projectId: null }, 0, [{ name: "A", value: "b", secret: false }]),
    { code: "forbidden" },
  );
  Atomics.store(proof.requestPermit, 0, 1);
  // A forged Actor or a malformed proof never selects a partition.
  await assert.rejects(
    f.owner.store.environmentList({ ...proof, actorId: "human://forged/actor" }, { projectId: null }),
    {
      code: "forbidden",
    },
  );
  await assert.rejects(f.owner.store.environmentList({ ...proof, extra: 1 } as never, { projectId: null }), {
    code: "forbidden",
  });
  assert.equal((await f.owner.store.environmentList(proof, { projectId: null })).revision, 0);
});
