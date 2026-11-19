import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { EmployeeGitVaultStore } from "../../../../scripts/employee-git-vault-store";
import {
  SandboxConfigurations,
  e2bEndpoint,
} from "../../assets/sandbox-configurations";
import { SANDBOX_CONFIG_PATH } from "../../assets/contract";
import { TencentOaServerPlugin } from "../../plugins/tencentoa/src/server";
import { createConfiguredSandboxProviders } from "../../assets/sandbox-providers.mjs";
import { createPersonalAssistantHost } from "../../../../apps/personal-assistant/src/runtime/host-supervisor.mjs";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../../../packages/access-control/src/actors";
import { Collaboration } from "../../../../packages/access-control/src/collaboration";
const scope = "tencentoa:100",
  key = "e2b-fixture-private-key";
const credential = (revision = 0, extra = {}) => ({
  action: "save-credential",
  revision,
  name: "E2B account",
  apiUrl: "https://api.e2b.dev",
  sandboxUrl: "https://e2b.dev",
  apiKey: key,
  ...extra,
});
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "assets-sandboxes-"));
  let vault = new EmployeeGitVaultStore(directory),
    store = new SandboxConfigurations(vault);
  t.after(async () => {
    vault.close();
    await rm(directory, { force: true, recursive: true });
  });
  return {
    directory,
    get store() {
      return store;
    },
    restart() {
      vault.close();
      vault = new EmployeeGitVaultStore(directory);
      store = new SandboxConfigurations(vault);
    },
  };
}
test("independent credentials, CAS, secret-free projection, encrypted persistence and restart", async (t) => {
  const f = await fixture(t);
  const saved = f.store.update(scope, credential(), false);
  assert.equal(saved.environments.length, 0);
  assert.equal(saved.credentials.length, 1);
  assert.ok(!JSON.stringify(saved).includes(key));
  assert.ok(!JSON.stringify(saved).includes("apiKey"));
  assert.equal(f.store.snapshot("tencentoa:200", false).credentials.length, 0);
  assert.throws(() => f.store.update(scope, credential(), false), /conflict/);
  const c = saved.credentials[0]!;
  const env = f.store.update(
    scope,
    {
      action: "save-environment",
      revision: 1,
      name: "Build box",
      templateId: "template-one",
      credentialId: c.id,
    },
    false,
  );
  assert.equal(env.environments.length, 1);
  assert.throws(
    () =>
      f.store.update(
        scope,
        { action: "delete-credential", revision: 2, id: c.id },
        false,
      ),
    /credential_in_use/,
  );
  f.restart();
  assert.equal(f.store.runtime(scope, false)[0]!.credential.apiKey, key);
  assert.equal(f.store.snapshot(scope, false).revision, 2);
  const bytes = await readFile(join(f.directory, "employee-git-vault.sqlite"));
  assert.ok(!bytes.includes(Buffer.from(key)));
  const rename = f.store.update(
    scope,
    credential(2, { id: c.id, name: "Renamed", apiKey: "" }),
    false,
  );
  assert.equal(rename.credentials[0]!.generation, c.generation);
  const rotated = f.store.update(
    scope,
    credential(3, { id: c.id, apiKey: "new-secret" }),
    false,
  );
  assert.notEqual(rotated.credentials[0]!.generation, c.generation);
  f.store.update(
    scope,
    { action: "delete-environment", revision: 4, id: env.environments[0]!.id },
    false,
  );
  f.store.update(
    scope,
    { action: "delete-credential", revision: 5, id: c.id },
    false,
  );
  assert.equal(f.store.snapshot(scope, false).credentials.length, 0);
});
test("strict endpoint trust and credential audiences, no environment or raw keys in public Bot selection", async (t) => {
  const f = await fixture(t);
  for (const endpoint of [
    "http://api.e2b.dev",
    "https://x.example/path",
    "https://user:pass@x.example",
    "https://x.example/?secret=1",
    "https://x.example/#a",
    "file:///tmp/key",
  ])
    assert.throws(() => e2bEndpoint(endpoint));
  assert.equal(e2bEndpoint("https://api.e2b.dev/"), "https://api.e2b.dev");
  assert.throws(
    () =>
      f.store.update(
        scope,
        credential(0, { apiUrl: "https://e2b.example" }),
        false,
      ),
    /custom_endpoint_admin/,
  );
  const a = f.store.update(
      scope,
      credential(0, {
        apiUrl: "https://e2b.example",
        sandboxUrl: "https://sandboxes.example",
      }),
      true,
    ),
    c = a.credentials[0]!;
  assert.throws(
    () =>
      f.store.update(
        scope,
        credential(1, { id: c.id, apiUrl: "https://evil.example" }),
        true,
      ),
    /audience_changed/,
  );
  assert.throws(
    () =>
      f.store.update(
        scope,
        {
          action: "save-environment",
          revision: 1,
          name: "Bad",
          credentialId: c.id,
          templateId: "ok",
          apiKey: key,
        },
        true,
      ),
    /invalid/,
  );
  f.store.update(
    scope,
    {
      action: "save-environment",
      revision: 1,
      name: "Custom",
      credentialId: c.id,
      templateId: "ok",
    },
    true,
  );
  assert.equal(f.store.runtime(scope, false).length, 0);
  assert.equal(f.store.runtime(scope, true).length, 1);
  assert.throws(
    () =>
      f.store.update(
        scope,
        {
          action: "save-environment",
          revision: 2,
          name: "Bad",
          credentialId: c.id,
          templateId: "../../code",
        },
        true,
      ),
    /invalid_template/,
  );
});
test("authenticated product route fences origin, account, admission, method, size and late revocation", async (t) => {
  const f = await fixture(t);
  let allowed = true,
    administrator = false;
  const plugin = new TencentOaServerPlugin(null, {
    identityResolver: () => ({
      provider: "tencentoa",
      subject: "100",
      displayName: "alice",
      attributes: { loginName: "alice" },
      expiresAt: Date.now() + 60000,
    }),
    sandboxConfigurations: {
      store: f.store,
      allowed: () => allowed,
      allowCustomEndpoints: () => false,
      canManagePlatform: () => administrator,
    },
  });
  const server = createServer((req, res) => {
    if (!plugin.handle(req, res)) {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        plugin.close();
        server.close(() => resolve());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as any).port}${SANDBOX_CONFIG_PATH}`;
  const call = async (
    body?: unknown,
    headers: Record<string, string> = {},
    method = body ? "POST" : "GET",
  ) => {
    const r = await fetch(url, {
      method,
      headers: {
        "x-opencraft-account-scope": scope,
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  assert.equal((await call()).status, 200);
  assert.match((await call()).headers.get("cache-control")!, /no-store/);
  assert.equal(
    (await call(undefined, { "x-opencraft-account-scope": "tencentoa:200" }))
      .status,
    409,
  );
  assert.equal(
    (await call(credential(), { origin: "https://evil.example" })).status,
    403,
  );
  assert.equal(
    (await call(credential(), { "sec-fetch-site": "cross-site" })).status,
    403,
  );
  assert.equal((await call(undefined, {}, "DELETE")).status, 405);
  assert.equal(
    (await call(credential(), { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal((await call({ padding: "x".repeat(17000) })).status, 413);
  const saved = await call(credential());
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.body).includes(key));
  assert.equal((await call(credential(0, { source: "platform" }))).status, 403);
  assert.equal(
    (await call(credential(0, { source: "platform", canManagePlatform: true })))
      .status,
    403,
  );
  administrator = true;
  assert.equal((await call(credential(0, { source: "platform" }))).status, 200);
  assert.equal((await call()).body.credentials.length, 2);
  // Admission stays valid while the administrator role is revoked mid-body.
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencraft-account-scope": scope,
        },
      },
      (res) => {
        assert.equal(res.statusCode, 403);
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.write("{");
    setTimeout(() => {
      administrator = false;
      req.end(
        '"revision":1,"source":"platform","action":"delete-credential","id":"x"}',
      );
    }, 30);
  });
  const member = await call();
  assert.equal(member.status, 200);
  assert.equal(member.body.credentials.length, 1);
  assert.equal(member.body.platformRevision, 1);
  allowed = false;
  assert.equal((await call()).status, 403);
  allowed = true;
  // Revoke after authentication while a body is still being delivered.
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencraft-account-scope": scope,
        },
      },
      (res) => {
        assert.equal(res.statusCode, 403);
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.write("{");
    setTimeout(() => {
      allowed = false;
      req.end('"revision":1,"action":"delete-credential","id":"x"}');
    }, 30);
  });
  assert.equal(f.store.snapshot(scope, false).revision, 1);
});
test("configured runtime catalogs are Human-scoped; listing has no remote create and rotation revokes leases", async (t) => {
  const f = await fixture(t),
    c = f.store.update(scope, credential(), false).credentials[0]!;
  f.store.update(
    scope,
    {
      action: "save-environment",
      revision: 1,
      name: "Build box",
      credentialId: c.id,
      templateId: "python",
    },
    false,
  );
  let admitted = true,
    generation = 1,
    creates = 0,
    spawns = 0,
    callback: any,
    backendOptions: any;
  const actor = {
    id: "alice",
    kind: "human",
    enabled: true,
    get generation() {
      return generation;
    },
  };
  const actors = {
    isCurrent: (ctx: any) =>
      ctx.actorId === "alice" &&
      ctx.generation === generation &&
      ctx.expiresAt > Date.now(),
    get: (id: string) =>
      id === "alice"
        ? actor
        : { id, kind: "human", enabled: true, generation: 1 },
    bindings: (id: string) => [
      { provider: "tencentoa", subject: id === "alice" ? "100" : "200" },
    ],
  };
  const access = {
    admitsActor: () => admitted,
    store: { actorMembership: () => ({ enabled: true, role: "member" }) },
  };
  const registry = createConfiguredSandboxProviders(
    f.store,
    { actors, getInstanceAccess: () => access },
    {
      backend: (options: any) => {
        backendOptions = options;
        return {};
      },
      createProvider: async (options: any) => {
        creates++;
        callback = { authorize: async () => {}, onLost: () => {} };
        options.createBackend(options.templates[0], callback);
        return {
          templates: async () => options.templates,
          spawn: async () => {
            spawns++;
            return {
              ready: Promise.resolve(),
              failed: () => false,
              close: async () => {},
            };
          },
          close: async () => {},
        };
      },
    },
  );
  t.after(() => registry.close());
  const ctx = {
    actorId: "alice",
    generation: 1,
    credentialId: null,
    expiresAt: Date.now() + 60000,
  };
  const map = await registry.forContext(ctx),
    ids = Object.keys(map);
  assert.equal(ids.length, 1);
  assert.equal(creates, 1);
  assert.equal(spawns, 0);
  assert.match(ids[0]!, /^e2b-/);
  assert.deepEqual(await registry.forContext({ ...ctx, actorId: "bob" }), {});
  assert.deepEqual(await registry.forContext({ ...ctx, expiresAt: 1 }), {});
  await registry.forContext(ctx);
  assert.equal(creates, 1);
  assert.equal(await backendOptions.readApiKey(), key);
  // Closing a browser session does not revoke a durably admitted Bot lease.
  ctx.expiresAt = 1;
  assert.equal(await backendOptions.readApiKey(), key);
  f.store.update(scope, credential(2, { id: c.id, apiKey: "rotated" }), false);
  await assert.rejects(backendOptions.lease.authorize({}), /unavailable/);
  await assert.rejects(backendOptions.readApiKey(), /unavailable/);
  ctx.expiresAt = Date.now() + 60000;
  const changedMap = await registry.forContext(ctx);
  assert.notEqual(
    Object.keys(changedMap)[0],
    ids[0],
    "rotation must require explicit new Bot environment selection",
  );
  await assert.rejects(
    map[ids[0]!].spawn(
      { kind: "sandbox", backendId: ids[0], templateId: "python" },
      {},
    ),
    /unavailable/,
  );
  assert.equal(creates, 2);
  generation = 2;
  await assert.rejects(backendOptions.readApiKey(), /unavailable/);
  admitted = false;
  assert.deepEqual(await registry.forContext({ ...ctx, generation: 2 }), {});
});
test("existing Host/Core paths carry the current Human on discovery, validation and spawn, without local fallback", async (t) => {
  const f = await fixture(t),
    storage = await openServerDatabase(f.directory),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  let host: any;
  t.after(async () => {
    await host?.close();
    await service.close();
    actors.close();
    await storage.close();
  });
  const principal = (id: string) => ({
    provider: "tencentoa",
    subject: id,
    displayName: "test",
    expiresAt: Date.now() + 60000,
  });
  const alice = actors.resolveHuman(principal("100"))!,
    bob = actors.resolveHuman(principal("200"))!;
  let spawned = 0;
  const seen: string[] = [];
  const provider = {
    templates: async () => [{ id: "python", name: "My environment" }],
    spawn: async () => {
      spawned++;
      return {
        ready: Promise.resolve(),
        failed: () => false,
        close: async () => {},
      };
    },
  };
  host = await createPersonalAssistantHost({
    directory: f.directory,
    service,
    intervalMs: 30,
    readConfig: async () => ({
      maxRuntimes: 2,
      profileOptions: { mode: "fixture" },
    }),
    spawn: () => {
      throw Error("local fallback forbidden");
    },
    environmentProvidersFor: async (context: any) => {
      seen.push(context.actorId);
      return context.actorId === alice.actorId
        ? { "e2b-private": provider }
        : {};
    },
  } as any);
  const method = "opencraft/personal-assistant/";
  assert.equal(
    (await service.personalAssistant(alice, method + "environments")).templates
      .length,
    1,
  );
  assert.equal(
    (await service.personalAssistant(bob, method + "environments")).templates
      .length,
    0,
  );
  const input = {
    name: "Remote",
    duties: "",
    clientRequestId: "create-remote",
    environment: {
      kind: "sandbox",
      backendId: "e2b-private",
      templateId: "python",
    },
  };
  await assert.rejects(
    service.personalAssistant(bob, method + "bots/create", input),
    /assistant_environment_unavailable/,
  );
  const result = await service.personalAssistant(
    alice,
    method + "bots/create",
    input,
  );
  const end = Date.now() + 5000;
  while (!spawned && Date.now() < end)
    await new Promise((r) => setTimeout(r, 30));
  assert.equal(spawned, 1);
  assert.ok(seen.includes(alice.actorId));
  assert.equal(
    (await service.personalAssistant(bob, method + "bots/list")).bots.length,
    0,
  );
  assert.ok(result.assistant.binding.botId);
});
test("platform custody is admin-only, metadata-safe, independently versioned and cannot borrow private connections", async (t) => {
  const f = await fixture(t);
  const own = f.store.update(scope, credential(), false);
  assert.throws(
    () => f.store.update(scope, credential(0, { source: "platform" }), false),
    /administrator_required/,
  );
  const platform = f.store.update(
    scope,
    credential(0, {
      source: "platform",
      apiKey: "platform-fixture-key",
      apiUrl: "https://platform.example",
      sandboxUrl: "https://sandbox.example",
    }),
    true,
    true,
  );
  const c = platform.credentials.find((c) => c.source === "platform")!;
  assert.equal(platform.revision, 1);
  assert.equal(platform.platformRevision, 1);
  const input = {
    action: "save-environment",
    source: "platform",
    revision: 1,
    name: "Shared development",
    credentialId: c.id,
    templateId: "python",
  };
  assert.throws(
    () =>
      f.store.update(
        scope,
        { ...input, credentialId: own.credentials[0]!.id },
        true,
        true,
      ),
    /credential_missing/,
  );
  const saved = f.store.update(scope, input, true, true);
  const bob = f.store.snapshot("tencentoa:200", false);
  assert.equal(bob.environments.length, 1);
  assert.equal(bob.environments[0]!.source, "platform");
  assert.deepEqual(bob.credentials, []);
  assert.equal(bob.environments[0]!.credentialId, undefined);
  assert.ok(!JSON.stringify(bob).includes("platform.example"));
  assert.ok(!JSON.stringify(saved).includes("platform-fixture-key"));
  assert.equal(f.store.runtime("tencentoa:200", false).length, 0);
  assert.equal(
    f.store.runtime("tencentoa:200", true, "platform")[0]!.credential.apiKey,
    "platform-fixture-key",
  );
  assert.throws(
    () => f.store.update(scope, { ...input, revision: 1 }, true, true),
    /conflict/,
  );
  assert.throws(
    () =>
      f.store.update(
        "tencentoa:200",
        { ...input, source: "personal", revision: 0 },
        false,
      ),
    /credential_missing/,
  );
  assert.throws(
    () =>
      f.store.update(
        scope,
        {
          action: "delete-environment",
          source: "personal",
          revision: 1,
          id: saved.environments[0]!.id,
        },
        true,
        true,
      ),
    /missing/,
  );
  assert.throws(
    () =>
      f.store.update(
        scope,
        { ...input, revision: 2, canManagePlatform: true },
        true,
        true,
      ),
    /invalid/,
  );
  f.restart();
  assert.equal(f.store.snapshot("tencentoa:200", false).platformRevision, 2);
});

test("public runtime pools are shared per configuration, never first-caller authority, and private IDs remain compatible", async (t) => {
  const { createHash } = await import("node:crypto");
  const f = await fixture(t),
    digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const c = f.store.update(scope, credential(), false).credentials[0]!;
  const e = f.store.update(
    scope,
    {
      action: "save-environment",
      revision: 1,
      name: "Private",
      credentialId: c.id,
      templateId: "python",
    },
    false,
  ).environments[0]!;
  const pc = f.store
    .update(
      scope,
      credential(0, { source: "platform", apiKey: "shared-key" }),
      true,
      true,
    )
    .credentials.find((c) => c.source === "platform")!;
  let publicSnapshot = f.store.update(
    scope,
    {
      action: "save-environment",
      source: "platform",
      revision: 1,
      name: "Shared",
      credentialId: pc.id,
      templateId: "python",
    },
    true,
    true,
  );
  const pe = publicSnapshot.environments.find((e) => e.source === "platform")!;
  const admitted = new Set(["alice", "bob"]),
    generations = new Map([
      ["alice", 1],
      ["bob", 1],
    ]);
  const actors = {
      isCurrent: (ctx: any) =>
        ctx.expiresAt > Date.now() &&
        generations.get(ctx.actorId) === ctx.generation,
      get: (id: string) => ({
        id,
        kind: "human",
        enabled: true,
        generation: generations.get(id),
      }),
      bindings: (id: string) => [
        { provider: "tencentoa", subject: id === "alice" ? "100" : "200" },
      ],
    },
    access = {
      admitsActor: (id: string) => admitted.has(id),
      store: { actorMembership: () => ({ enabled: true, role: "member" }) },
    };
  let spawnGate: Promise<void> | undefined;
  const leaseRequests = new Map<string, any>();
  const native = new Map<string, any>(),
    callbacksSeen: string[] = [];
  let creates = 0,
    spawns = 0,
    closes = 0,
    postSpawn: (() => void) | undefined;
  const registry = createConfiguredSandboxProviders(
    f.store,
    { actors, getInstanceAccess: () => access },
    {
      backend: (options: any) => options,
      createProvider: async (options: any) => {
        creates++;
        const backend = options.createBackend(options.templates[0], {
          authorize: async (identity: any) => {
            callbacksSeen.push(identity.actorId);
            if (!admitted.has(identity.actorId)) throw Error("lease_revoked");
          },
          onLost: () => {},
        });
        native.set(options.backendId, { backend, options });
        return {
          validate: async () => {},
          spawn: async (_environment: any, options: any) => {
            leaseRequests.set(
              options.backendId ?? _environment.backendId,
              options.request,
            );
            spawns++;
            await spawnGate;
            postSpawn?.();
            return {
              ready: Promise.resolve(),
              failed: () => false,
              close: async () => {
                closes++;
              },
            };
          },
          close: async () => {},
        };
      },
    },
  );
  t.after(() => registry.close());
  const ctx = (actorId: string) => ({
    actorId,
    generation: 1,
    credentialId: null,
    expiresAt: Date.now() + 60000,
  });
  const alice = await registry.forContext(ctx("alice")),
    bob = await registry.forContext(ctx("bob"));
  const publicId = Object.keys(bob)[0]!;
  assert.match(publicId, /^e2b-shared-/);
  assert.equal(Object.keys(alice).length, 2);
  assert.equal(
    creates,
    2,
    "one private pool and one platform pool, not per member",
  );
  assert.equal(spawns, 0, "listing never allocates a cloud sandbox");
  assert.ok(alice[publicId]);
  const expectedPrivate =
    "e2b-" +
    digest([
      scope,
      1,
      digest([e.id, e.templateId, c.id, c.generation, c.apiUrl, c.sandboxUrl]),
    ]).slice(0, 40);
  assert.ok(
    alice[expectedPrivate],
    "existing personal Bot IDs must not change",
  );
  const publicBackend = native.get(publicId);
  assert.deepEqual(publicBackend.options.capacity, {
    cpuMillis: 4000,
    memoryBytes: 8589934592,
  });
  admitted.delete("alice");
  generations.set("alice", 2);
  assert.equal(
    await publicBackend.backend.readApiKey(),
    "shared-key",
    "public pool never captures its first Human",
  );
  await publicBackend.backend.lease.authorize({ actorId: "bob" });
  await assert.rejects(
    publicBackend.backend.lease.authorize({ actorId: "alice" }),
    /lease_revoked/,
  );
  await assert.rejects(alice[publicId].templates(), /unavailable/);
  assert.equal((await bob[publicId].templates())[0].name, "Shared");
  publicSnapshot = f.store.update(
    scope,
    {
      action: "save-environment",
      source: "platform",
      revision: 2,
      id: pe.id,
      name: "Renamed",
      credentialId: pc.id,
      templateId: "python",
    },
    true,
    true,
  );
  assert.equal((await bob[publicId].templates())[0].name, "Renamed");
  assert.equal(Object.keys(await registry.forContext(ctx("bob")))[0], publicId);
  let forwarded = 0;
  await bob[publicId].spawn(
    { kind: "sandbox", backendId: publicId, templateId: "python" },
    {
      request: async () => {
        forwarded++;
        return { accepted: true };
      },
    },
  );
  const commandAuthority = leaseRequests.get(publicId);
  await commandAuthority("opencraft/personal-assistant/authorize", {});
  assert.equal(forwarded, 1);
  postSpawn = () => admitted.delete("bob");
  await assert.rejects(
    bob[publicId].spawn(
      { kind: "sandbox", backendId: publicId, templateId: "python" },
      {},
    ),
    /unavailable/,
  );
  assert.equal(closes, 1, "late revocation closes the allocated handle");
  admitted.add("bob");
  postSpawn = undefined;
  f.store.update(
    scope,
    credential(publicSnapshot.platformRevision!, {
      source: "platform",
      id: pc.id,
      apiKey: "rotated-public",
    }),
    true,
    true,
  );
  await assert.rejects(publicBackend.backend.readApiKey(), /unavailable/);
  await assert.rejects(
    publicBackend.backend.lease.authorize({ actorId: "bob" }),
    /unavailable/,
  );
  await assert.rejects(bob[publicId].templates(), /unavailable/);
  await assert.rejects(
    commandAuthority("opencraft/personal-assistant/authorize", {}),
    /unavailable/,
  );
  assert.equal(
    forwarded,
    1,
    "existing commands must stop immediately, not wait for renewal",
  );
  const fresh = await registry.forContext(ctx("bob"));
  assert.notEqual(Object.keys(fresh)[0], publicId);
  let release!: () => void;
  spawnGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const newId = Object.keys(fresh)[0]!;
  const pending = fresh[newId].spawn(
    { kind: "sandbox", backendId: newId, templateId: "python" },
    {},
  );
  const rejected = assert.rejects(pending, /unavailable/);
  let closed = false;
  const shutdown = registry.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false, "shutdown must await in-flight allocations");
  release();
  await rejected;
  await shutdown;
  assert.equal(
    closes,
    2,
    "late allocated handle is closed before shutdown resolves",
  );
});
test("a stale public catalog cannot close a newer pool created during cleanup", async (t) => {
  const f = await fixture(t);
  const c = f.store.update(
    scope,
    credential(0, { source: "platform" }),
    true,
    true,
  ).credentials[0]!;
  for (const [i, name] of ["One", "Two"].entries())
    f.store.update(
      scope,
      {
        action: "save-environment",
        source: "platform",
        revision: i + 1,
        name,
        credentialId: c.id,
        templateId: "python",
      },
      true,
      true,
    );
  const actors = {
    isCurrent: () => true,
    get: (id: string) => ({ id, kind: "human", enabled: true, generation: 1 }),
    bindings: () => [{ provider: "tencentoa", subject: "100" }],
  };
  let first = true,
    release!: () => void,
    entered!: () => void;
  const blocked = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const closed = new Set<string>();
  const registry = createConfiguredSandboxProviders(
    f.store,
    {
      actors,
      getInstanceAccess: () => ({
        admitsActor: () => true,
        store: { actorMembership: () => ({ enabled: true, role: "member" }) },
      }),
    },
    {
      createProvider: async (options: any) => ({
        close: async () => {
          if (first) {
            first = false;
            entered();
            await blocked;
          }
          closed.add(options.backendId);
        },
      }),
    },
  );
  t.after(() => registry.close());
  const ctx = {
    actorId: "alice",
    generation: 1,
    expiresAt: Date.now() + 60000,
    credentialId: null,
  };
  await registry.forContext(ctx);
  f.store.update(
    scope,
    credential(3, { source: "platform", id: c.id, apiKey: "version-two" }),
    true,
    true,
  );
  const stale = registry.forContext(ctx);
  const rejection = assert.rejects(stale, /unavailable/);
  await started;
  f.store.update(
    scope,
    credential(4, { source: "platform", id: c.id, apiKey: "version-three" }),
    true,
    true,
  );
  const freshPending = registry.forContext(ctx);
  release();
  const fresh = await freshPending;
  await rejection;
  assert.equal(Object.keys(fresh).length, 2);
  for (const [id, provider] of Object.entries(fresh) as [string, any][]) {
    assert.equal(
      closed.has(id),
      false,
      "newly published live pool must not be closed by stale cleanup",
    );
    assert.equal((await provider.templates()).length, 1);
  }
});
test("real native provider keeps separate Bot leases and fences existing commands after platform removal", async (t) => {
  const { createSandboxAssistantProvider } = await import(
    "../../../../apps/personal-assistant/src/runtime/sandbox-environment-provider.mjs"
  );
  const f = await fixture(t),
    c = f.store.update(scope, credential(0, { source: "platform" }), true, true)
      .credentials[0]!;
  const env = f.store.update(
    scope,
    {
      action: "save-environment",
      source: "platform",
      revision: 1,
      name: "Public",
      credentialId: c.id,
      templateId: "python",
    },
    true,
    true,
  ).environments[0]!;
  const actors = {
    isCurrent: () => true,
    get: (id: string) => ({ id, kind: "human", enabled: true, generation: 1 }),
    bindings: (id: string) => [{ provider: "tencentoa", subject: id }],
  };
  const calls: any[] = [];
  let allocations = 0,
    providers = 0;
  const registry = createConfiguredSandboxProviders(
    f.store,
    {
      actors,
      getInstanceAccess: () => ({
        admitsActor: () => true,
        store: { actorMembership: () => ({ enabled: true, role: "member" }) },
      }),
    },
    {
      createProvider: async (options: any) => {
        providers++;
        return createSandboxAssistantProvider({
          ...options,
          spawnLocal: (options: any) => {
            calls.push(options);
            return {
              ready: Promise.resolve(),
              failed: () => false,
              close: async () => {},
            };
          },
        });
      },
      backend: () => ({
        initialize: async () => {},
        close: async () => {},
        create: async () => {
          allocations++;
          throw Error("cloud must not be called");
        },
      }),
    },
  );
  t.after(() => registry.close());
  const ctx = (actorId: string) => ({
    actorId,
    generation: 1,
    expiresAt: Date.now() + 60000,
    credentialId: null,
  });
  for (const id of ["alice", "bob"]) {
    const map = await registry.forContext(ctx(id)),
      backendId = Object.keys(map)[0]!;
    await map[backendId].spawn(
      { kind: "sandbox", backendId, templateId: "python" },
      {
        directory: f.directory,
        profileOptions: {},
        request: async () => ({
          binding: {
            serverId: "server",
            botId: id,
            assignmentId: "assignment-" + id,
            owner: { kind: "human", id },
          },
          epoch: "epoch-" + id,
          expiresAt: Date.now() + 60000,
        }),
      },
    );
  }
  assert.equal(providers, 1);
  assert.equal(allocations, 0);
  assert.notEqual(
    calls[0].executionEnvironment.binding,
    calls[1].executionEnvironment.binding,
  );
  f.store.update(
    scope,
    {
      action: "delete-environment",
      source: "platform",
      revision: 2,
      id: env.id,
    },
    true,
    true,
  );
  for (const call of calls)
    await assert.rejects(
      call.request("environment/run", {
        argv: ["/usr/bin/python3", "-c", "print(1)"],
        workId: "work",
        callId: "call",
      }),
      /unavailable/,
    );
  assert.equal(
    allocations,
    0,
    "native command authorization must reject before a cloud allocation",
  );
});
test("returning to a retiring fingerprint waits for cleanup before reusing its backend ID", async (t) => {
  const f = await fixture(t),
    c = f.store.update(scope, credential(0, { source: "platform" }), true, true)
      .credentials[0]!;
  const e = f.store.update(
    scope,
    {
      action: "save-environment",
      source: "platform",
      revision: 1,
      name: "A",
      credentialId: c.id,
      templateId: "template-a",
    },
    true,
    true,
  ).environments[0]!;
  const actors = {
    isCurrent: () => true,
    get: (id: string) => ({ id, kind: "human", enabled: true, generation: 1 }),
    bindings: () => [{ provider: "tencentoa", subject: "100" }],
  };
  let release!: () => void,
    entered!: () => void,
    created = 0,
    closedOnce = false;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const registry = createConfiguredSandboxProviders(
    f.store,
    {
      actors,
      getInstanceAccess: () => ({
        admitsActor: () => true,
        store: { actorMembership: () => ({ enabled: true, role: "member" }) },
      }),
    },
    {
      createProvider: async () => {
        created++;
        let retired = false;
        return {
          validate: async () => {
            assert.equal(retired, false);
          },
          close: async () => {
            retired = true;
            if (!closedOnce) {
              closedOnce = true;
              entered();
              await gate;
            }
          },
        };
      },
    },
  );
  t.after(() => registry.close());
  const ctx = {
    actorId: "alice",
    generation: 1,
    expiresAt: Date.now() + 60000,
    credentialId: null,
  };
  const first = await registry.forContext(ctx),
    id = Object.keys(first)[0]!;
  f.store.update(
    scope,
    {
      action: "save-environment",
      source: "platform",
      revision: 2,
      id: e.id,
      name: "B",
      credentialId: c.id,
      templateId: "template-b",
    },
    true,
    true,
  );
  const stale = assert.rejects(registry.forContext(ctx), /unavailable/);
  await started;
  f.store.update(
    scope,
    {
      action: "save-environment",
      source: "platform",
      revision: 3,
      id: e.id,
      name: "A again",
      credentialId: c.id,
      templateId: "template-a",
    },
    true,
    true,
  );
  let returned = false;
  const restored = registry.forContext(ctx).then((map: any) => {
    returned = true;
    return map;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    returned,
    false,
    "closing native provider must not be advertised as available",
  );
  release();
  const current = await restored;
  await stale;
  assert.equal(created, 2);
  assert.ok(current[id]);
  await current[id].validate({
    kind: "sandbox",
    backendId: id,
    templateId: "template-a",
  });
  await assert.rejects(first[id].templates(), /unavailable/);
});

const installedFixture = () => ({
  schemaVersion: 1,
  backend: "e2b",
  apiUrl: "https://beijing.example.test",
  sandboxUrl: "https://beijing.example.test",
  capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 },
  templates: ["base", "browser"].map((id) => ({
    id,
    name: id,
    resources: { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 },
    workspaceRoot: "/workspace",
  })),
  lease: { timeoutMs: 300000, renewEveryMs: 60000, maxLifetimeMs: 3600000 },
  persistentWorkspaces: true,
  maxCommandMs: 60000,
});
test("installation adoption is one-way, encrypted, visible in the shared catalogue and editable only by admins", async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.adoptInstallation(installedFixture(), key), true);
  let admin = f.store.snapshot(scope, true, true);
  const member = f.store.snapshot("tencentoa:200", false, false);
  assert.equal(admin.environments.length, 2);
  assert.equal(member.environments.length, 2);
  assert.equal(member.credentials.length, 0);
  assert.ok(!JSON.stringify(admin).includes(key));
  assert.ok(!JSON.stringify(member).includes("apiKey"));
  assert.equal(f.store.installedRuntime()!.policy.persistentWorkspaces, true);
  assert.throws(
    () =>
      f.store.update(
        scope,
        {
          action: "delete-environment",
          source: "platform",
          id: admin.environments[0]!.id,
          revision: admin.platformRevision,
        },
        true,
        false,
      ),
    /administrator_required/,
  );
  const env = admin.environments[0]!;
  admin = f.store.update(
    scope,
    {
      action: "save-environment",
      source: "platform",
      id: env.id,
      name: "Renamed",
      credentialId: env.credentialId,
      templateId: env.templateId,
      revision: admin.platformRevision,
    },
    true,
    true,
  );
  assert.equal(
    f.store
      .installedRuntime()!
      .records.find((r) => r.environment.id === env.id)!.environment.name,
    "Renamed",
  );
  f.restart();
  assert.equal(f.store.hasInstallation(), true);
  assert.equal(
    f.store.adoptInstallation(installedFixture(), "must-not-reimport"),
    false,
  );
  assert.equal(f.store.installedRuntime()!.records[0]!.credential.apiKey, key);
  for (const e of admin.environments)
    admin = f.store.update(
      scope,
      {
        action: "delete-environment",
        source: "platform",
        id: e.id,
        revision: admin.platformRevision,
      },
      true,
      true,
    );
  assert.equal(f.store.installedRuntime()!.records.length, 0);
  assert.equal(f.store.adoptInstallation(installedFixture(), key), false);
  assert.equal(f.store.snapshot(scope, true, true).environments.length, 0);
});
test("installed provider retains e2b identity, both templates and capacities while following catalogue edits", async (t) => {
  const { createInstalledSandboxProviders } = await import(
    "../../assets/installed-sandbox-providers.mjs"
  );
  const f = await fixture(t);
  f.store.adoptInstallation(installedFixture(), key);
  let admitted = true,
    closed = 0;
  const opts: any[] = [],
    backends: any[] = [];
  const providers = createInstalledSandboxProviders(f.store, {
    authorizeOwner: () => {
      if (!admitted) throw Error("revoked");
    },
    backend: (v: any) => {
      backends.push(v);
      return {};
    },
    createProvider: async (v: any) => {
      opts.push(v);
      for (const template of v.templates)
        v.createBackend(template, {
          authorize: async () => {},
          workspaceId: async () => "ws-" + "a".repeat(32),
          onLost() {},
        });
      return {
        validate: async () => {},
        spawn: async (_: any, o: any) => {
          await o.request("authorize", {});
          return { close: async () => {} };
        },
        close: async () => {
          closed++;
        },
      };
    },
  });
  let catalogue = await providers.forContext({});
  assert.deepEqual(Object.keys(catalogue), ["e2b"]);
  assert.equal(opts[0].backendId, "e2b");
  assert.equal(opts[0].templates.length, 2);
  assert.equal(opts[0].templates[0].workspaceRoot, "/workspace");
  assert.equal(opts[0].templates[0].resources.cpuMillis, 8000);
  assert.equal(opts[0].capacity.cpuMillis, 16000);
  assert.equal(opts[0].persistentWorkspaces, true);
  assert.equal(await backends[0].readWorkspaceId({}), "ws-" + "a".repeat(32));
  assert.equal(await backends[0].readApiKey(), key);
  let a = f.store.snapshot(scope, true, true);
  const credential = a.credentials[0]!;
  a = f.store.update(
    scope,
    {
      action: "save-credential",
      source: "platform",
      revision: a.platformRevision,
      id: credential.id,
      name: credential.name,
      apiUrl: credential.apiUrl,
      sandboxUrl: credential.sandboxUrl,
      apiKey: "rotated-fixture",
    },
    true,
    true,
  );
  await assert.rejects(backends[0].readApiKey());
  catalogue = await providers.forContext({});
  assert.equal(closed, 1);
  assert.equal(opts[1].backendId, "e2b");
  assert.equal(await backends.at(-1).readApiKey(), "rotated-fixture");
  admitted = false;
  await assert.rejects(catalogue.e2b.templates());
  await providers.close();
  assert.equal(closed, 2);
});
test('completed migration never rereads legacy config/key, including after administrator deletes every environment', async t=>{
 const {writeFile,unlink}=await import('node:fs/promises');
 const {migrateInstalledSandboxConfiguration}=await import('../../assets/installed-sandbox-config');
 const f=await fixture(t),config=join(f.directory,'installation.json'),secret=join(f.directory,'key');
 await writeFile(secret,key,{mode:0o600});await writeFile(config,JSON.stringify({...installedFixture(),apiKeyFile:secret}),{mode:0o600});
 assert.equal(await migrateInstalledSandboxConfiguration(f.store,config),true);
 await unlink(secret);await unlink(config);f.restart();
 assert.equal(await migrateInstalledSandboxConfiguration(f.store,config),false);
 let snapshot=f.store.snapshot(scope,true,true);
 for(const e of snapshot.environments)snapshot=f.store.update(scope,{source:'platform',action:'delete-environment',id:e.id,revision:snapshot.platformRevision},true,true);
 assert.equal(await migrateInstalledSandboxConfiguration(f.store,config),false);assert.equal(f.store.snapshot(scope,true,true).environments.length,0);
});
