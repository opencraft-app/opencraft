import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { openAssetConfigurations, type AssetAdmission } from "../../plugins/assets/src/server/worker.js";
import {
  assetConfigurationsHttp,
  ASSET_CONFIGURATIONS_PATH,
  type AssetRequestAuthority,
} from "../../plugins/assets/src/server/http.js";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { SandboxConfigurations } from "../../plugins/assets/src/server/configurations.js";
import { ManagedNfsLibraries } from "../../plugins/assets/src/server/libraries.js";
import { PLATFORM_ASSET_SCOPE } from "../../plugins/assets/src/contract.js";
const scope = "actor:human://fixture/one";
const secret = "fixture-asset-secret-not-a-real-key";
const credential = (revision = 0, extra = {}) => ({
  action: "save-credential",
  revision,
  name: "E2B",
  apiUrl: "https://api.e2b.dev",
  sandboxUrl: "https://e2b.dev",
  apiKey: secret,
  ...extra,
});
function admission(extra: Partial<AssetAdmission> = {}): AssetAdmission {
  const permit = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(permit, 0, 1);
  return {
    scope,
    permit,
    expiresAt: Date.now() + 60_000,
    canManagePlatform: false,
    allowCustomEndpoints: false,
    ...extra,
  };
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "public-assets-"));
  let owner = await openAssetConfigurations(directory);
  t.after(async () => {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get store() {
      return owner.store;
    },
    close: () => owner.close(),
    async restart() {
      await owner.close();
      owner = await openAssetConfigurations(directory);
    },
  };
}
test("real Worker reuses encrypted namespace, metadata-only projections, CAS and restart", async (t) => {
  const f = await fixture(t),
    access = admission();
  const first = await f.store.update(access, credential());
  assert.equal(first.credentials.length, 1);
  assert.equal(first.revision, 1);
  assert.ok(!JSON.stringify(first).includes(secret));
  assert.ok(!JSON.stringify(first).includes("apiKey"));
  await assert.rejects(f.store.update(access, credential()), { code: "conflict", status: 409 });
  const c = first.credentials[0]!;
  const env = await f.store.update(access, {
    action: "save-environment",
    revision: 1,
    name: "Build",
    credentialId: c.id,
    templateId: "pinned-template",
  });
  await assert.rejects(f.store.update(access, { action: "delete-credential", revision: 2, id: c.id }), {
    code: "credential_in_use",
  });
  await f.restart();
  assert.deepEqual(await f.store.snapshot(admission()), env);
  assert.equal((await f.store.snapshot(admission({ scope: "actor:human://fixture/two" }))).credentials.length, 0);
  const renamed = await f.store.update(admission(), credential(2, { id: c.id, name: "Renamed", apiKey: "" }));
  assert.equal(renamed.credentials[0]!.generation, c.generation);
  const rotated = await f.store.update(admission(), credential(3, { id: c.id, apiKey: "different-fixture-secret" }));
  assert.notEqual(rotated.credentials[0]!.generation, c.generation);
  await f.close();
  for (const name of ["employee-git-vault.sqlite", "employee-git-vault.key"]) {
    assert.ok(!(await readFile(join(f.directory, name))).includes(Buffer.from(secret)));
  }
  // The existing synchronous runtime owner still reads the same original partition.
  const vault = await EmployeeGitVaultStore.open(f.directory);
  try {
    assert.equal(
      new SandboxConfigurations(vault).runtime(scope, false)[0]!.credential.apiKey,
      "different-fixture-secret",
    );
  } finally {
    vault.close();
  }
});
test("only one concurrent expected revision wins; close drains and refuses later calls", async (t) => {
  const f = await fixture(t);
  const writes = [f.store.update(admission(), credential()), f.store.update(admission(), credential())];
  const closing = f.close();
  const results = await Promise.allSettled(writes);
  await closing;
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  await assert.rejects(f.store.snapshot(admission()), /closed/);
});
test("queued/revoked/expired requests never write; platform partition is not a personal scope", async (t) => {
  const f = await fixture(t),
    revoked = admission();
  Atomics.store(revoked.permit, 0, 0);
  for (const invalid of [
    revoked,
    admission({ expiresAt: Date.now() - 1 }),
    admission({ scope: PLATFORM_ASSET_SCOPE }),
    admission({ permit: new Int32Array(1) as Int32Array<SharedArrayBuffer> }),
  ]) {
    await assert.rejects(f.store.update(invalid, credential()), { code: "forbidden", status: 403 });
  }
  assert.equal((await f.store.snapshot(admission())).revision, 0);
});
test("custom endpoints and platform writes require independent trusted permissions", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.update(admission(), credential(0, { apiUrl: "https://api.example.test" })), {
    code: "custom_endpoint_admin",
    status: 403,
  });
  await assert.rejects(f.store.update(admission(), credential(0, { source: "platform" })), {
    code: "administrator_required",
    status: 403,
  });
  const platform = await f.store.update(admission({ canManagePlatform: true }), credential(0, { source: "platform" }));
  const c = platform.credentials[0]!;
  await f.store.update(admission({ canManagePlatform: true }), {
    action: "save-environment",
    source: "platform",
    revision: 1,
    name: "Platform",
    credentialId: c.id,
    templateId: "verified-template",
  });
  const member = await f.store.snapshot(admission());
  assert.equal(member.credentials.length, 0);
  assert.equal(member.environments.length, 1);
  assert.equal(member.environments[0]!.credentialId, undefined);
  assert.equal(member.canManagePlatform, false);
  await assert.rejects(f.store.update(admission(), credential(0, { action: "unknown", secret })), { code: "invalid" });
});
test("legacy installed policy and verified NFS declaration remain runtime-owned, generation-pinned and secret-free", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "asset-installed-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const vault = await EmployeeGitVaultStore.open(directory),
    store = new SandboxConfigurations(vault);
  try {
    assert.equal(
      store.adoptInstallation(
        {
          apiUrl: "https://api.e2b.dev",
          sandboxUrl: "https://e2b.dev",
          capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
          lease: { timeoutMs: 60_000, renewEveryMs: 10_000, maxLifetimeMs: 3600_000 },
          templates: [
            {
              id: "verified-template",
              name: "Build",
              workspaceRoot: "/workspace",
              resources: { cpuMillis: 1000, memoryBytes: 1024 ** 3 },
            },
          ],
        },
        secret,
      ),
      true,
    );
    const installed = store.installedRuntime()!.records[0]!;
    new ManagedNfsLibraries(vault).register(
      {
        id: "library",
        name: "Shared data",
        kind: "nfs",
        managedBy: "e2b",
        mountPath: "/shared",
        credentialId: installed.credential.id,
        credentialGeneration: installed.credential.generation,
        volumeId: "provider-volume",
        environmentIds: [installed.environment.id],
        templateIds: ["verified-template"],
        verifiedAt: new Date().toISOString(),
      },
      0,
    );
    assert.equal(store.snapshot(scope, false).libraries![0]!.status, "configured");
    const rotated = store.update(
      scope,
      credential(1, { source: "platform", id: installed.credential.id, apiKey: "rotated-fixture" }),
      false,
      true,
    );
    assert.equal(rotated.libraries![0]!.status, "unavailable");
    assert.ok(!JSON.stringify(rotated).includes("provider-volume"));
  } finally {
    vault.close();
  }
  const owner = await openAssetConfigurations(directory);
  try {
    assert.equal((await owner.store.snapshot(admission())).libraries![0]!.status, "unavailable");
  } finally {
    await owner.close();
  }
});
test("Worker startup rejects unsafe storage permissions without a main-thread fallback", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "asset-permissions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await chmod(directory, 0o755);
  await assert.rejects(openAssetConfigurations(directory));
});

async function httpFixture(t: test.TestContext) {
  const f = await fixture(t);
  const listeners = new Set<() => void>();
  let allowed = true,
    administrator = false,
    scopeNow = scope;
  let origin = "",
    delay: (() => Promise<void>) | undefined;
  const handler = assetConfigurationsHttp(
    {
      snapshot: (access) => f.store.snapshot(access),
      async update(access, input) {
        await delay?.();
        return f.store.update(access, input);
      },
    },
    () => {
      if (!allowed) return null;
      const atStart = scopeNow,
        role = administrator;
      const access: AssetRequestAuthority = {
        scope: atStart,
        origin,
        expiresAt: Date.now() + 60_000,
        canManagePlatform: role,
        allowCustomEndpoints: role,
        current: () => allowed && scopeNow === atStart && role === administrator,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
      return access;
    },
  );
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const change = (fn: () => void) => {
    fn();
    for (const listener of listeners) listener();
  };
  return {
    ...f,
    origin,
    listeners,
    setAllowed: (value: boolean) =>
      change(() => {
        allowed = value;
      }),
    setAdministrator: (value: boolean) =>
      change(() => {
        administrator = value;
      }),
    setScope: (value: string) =>
      change(() => {
        scopeNow = value;
      }),
    delay: (fn: () => Promise<void>) => {
      delay = fn;
    },
    async request(method: string, body?: unknown, headers = {}) {
      return fetch(origin + ASSET_CONFIGURATIONS_PATH, {
        method,
        headers: { "x-opencraft-account-scope": scope, "content-type": "application/json", origin, ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    },
  };
}
test("real HTTP + Worker: authenticated partition fencing, same-origin, limits and no secret response", async (t) => {
  const f = await httpFixture(t);
  assert.equal((await f.request("GET", undefined, { "x-opencraft-account-scope": "other" })).status, 409);
  assert.equal((await f.request("POST", credential(), { origin: "https://attacker.example" })).status, 403);
  assert.equal((await f.request("GET", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await f.request("POST", credential(), { "content-type": "text/plain" })).status, 415);
  assert.equal((await f.request("POST", { value: "x".repeat(16385) })).status, 413);
  assert.equal((await f.request("DELETE")).status, 405);
  const response = await f.request("POST", credential());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const data = await response.json();
  assert.equal(data.revision, 1);
  assert.ok(!JSON.stringify(data).includes(secret));
  assert.equal((await f.request("POST", credential())).status, 409);
  f.setAllowed(false);
  assert.equal((await f.request("GET")).status, 403);
  assert.equal(f.listeners.size, 0);
});
for (const change of ["account", "membership", "administrator"] as const)
  test(`HTTP permission loss during queued Worker dispatch rejects ${change} without writing or replay`, async (t) => {
    const f = await httpFixture(t);
    if (change === "administrator") f.setAdministrator(true);
    let arrived!: () => void, resume!: () => void;
    const queued = new Promise<void>((resolve) => {
        arrived = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
    f.delay(async () => {
      arrived();
      await gate;
    });
    const pending = f.request("POST", credential(0, change === "administrator" ? { source: "platform" } : {}));
    await queued;
    if (change === "account") f.setScope("actor:human://fixture/two");
    else if (change === "membership") f.setAllowed(false);
    else f.setAdministrator(false);
    resume();
    assert.equal((await pending).status, 403);
    const state = await f.store.snapshot(admission({ canManagePlatform: true }));
    assert.equal(state.revision, 0);
    assert.equal(state.platformRevision, 0);
    assert.equal(f.listeners.size, 0);
  });
test("revocation while the real HTTP body is incomplete prevents dispatch", async (t) => {
  const f = await httpFixture(t),
    body = JSON.stringify(credential());
  const request = httpRequest(f.origin + ASSET_CONFIGURATIONS_PATH, {
    method: "POST",
    headers: {
      "x-opencraft-account-scope": scope,
      "content-type": "application/json",
      origin: f.origin,
    },
  });
  const result = once(request, "response");
  request.write(body.slice(0, 10));
  while (f.listeners.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  f.setAllowed(false);
  request.end(body.slice(10));
  const [response] = await result;
  assert.equal(response.statusCode, 403);
  response.resume();
  assert.equal((await f.store.snapshot(admission())).revision, 0);
});

test("vault lock waits stay in the Worker: HTTP and timers remain live, revoked queued writes cannot commit", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await httpFixture(t);
  const lock = new DatabaseSync(join(f.directory, "employee-git-vault.sqlite"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    let settled = false;
    const first = f.store.update(admission(), credential()).finally(() => {
      settled = true;
    });
    const later = admission();
    const second = f.store.update(later, credential(1));
    // Attach the rejection observer before withdrawing admission.
    const rejected = assert.rejects(second, { code: "forbidden", status: 403 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false, "write must still be waiting for the database lock");
    // A non-assets route can still respond while the assets Worker is blocked.
    const response = await fetch(f.origin + "/not-an-assets-route", { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 404);
    Atomics.store(later.permit, 0, 0);
    lock.exec("ROLLBACK");
    await first;
    await rejected;
    assert.equal((await f.store.snapshot(admission())).revision, 1);
  } finally {
    if (lock.isTransaction) lock.exec("ROLLBACK");
    lock.close();
  }
});
