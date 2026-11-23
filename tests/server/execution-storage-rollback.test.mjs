import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createManagedWebServer } from "../../scripts/web-deployment/server.mjs";
import { createExecutionDeployment } from "../../scripts/server-deployment/execution.mjs";
import {
  advancedStores,
  emptyStorageRecord,
  observeDatabases,
  observeRelease,
  readStorageRecord,
  retainReleases,
  storageVersionsFromHealth,
} from "../../scripts/server-deployment/storage-versions.mjs";
import { parseWebUpdateStatus } from "../../packages/web-update-protocol/src/index.mjs";
import { releaseFixture } from "../support/web-deployment-fixture.mjs";

async function until(read, condition) {
  for (let i = 0; i < 500; i++) {
    const value = await read();
    if (condition(value)) return value;
    await delay(20);
  }
  throw new Error("Update did not finish");
}

test("storage versions come only from well-formed health entries", () => {
  assert.equal(storageVersionsFromHealth({ ok: true }), null);
  assert.deepEqual(
    storageVersionsFromHealth({
      storage: [
        { name: "threads", appliedVersion: 2 },
        { name: "tasks", hostId: "local", appliedVersion: 5 },
        { name: "bad name with spaces", appliedVersion: 1 },
        { name: "executions", appliedVersion: -1 },
        { name: "routing", appliedVersion: "3" },
        { name: "docs", hostId: 7, appliedVersion: 1 },
      ],
    }),
    { ":threads": 2, "local:tasks": 5 },
  );
});

test("a release is blocked only for stores it reported at a lower version", () => {
  let record = observeRelease(emptyStorageRecord(), "/r/old", { ":threads": 1, ":tasks": 5 });
  record = observeDatabases(record, { ":threads": 2, ":tasks": 5, ":new-store": 1 });
  assert.deepEqual(advancedStores(record, "/r/old"), [{ key: ":threads", from: 1, to: 2 }]);
  // A release never observed is not guessed about, and unchanged stores do not block.
  assert.deepEqual(advancedStores(record, "/r/unknown"), []);
  assert.deepEqual(advancedStores(observeRelease(emptyStorageRecord(), "/r/old", { ":threads": 2 }), "/r/old"), []);
  // Observations of one release merge, so lazily opened stores are not forgotten.
  const merged = observeRelease(observeRelease(emptyStorageRecord(), "/r/a", { ":threads": 1 }), "/r/a", {
    ":tasks": 5,
  });
  assert.deepEqual(merged.releases["/r/a"], { ":threads": 1, ":tasks": 5 });
  assert.deepEqual(Object.keys(retainReleases(merged, ["/r/b"]).releases), []);
});

test("an unreadable storage record falls back to no guard instead of blocking startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-storage-record-"));
  try {
    const path = join(root, "record.json");
    await writeFile(path, '{"schemaVersion":1,"releases":{},"current":{"x y":1}}');
    assert.deepEqual(await readStorageRecord(path), emptyStorageRecord());
    assert.deepEqual(await readStorageRecord(join(root, "missing.json")), emptyStorageRecord());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback is refused before restart once the candidate upgraded the databases", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-storage-rollback-"));
  let app, fixture, base;
  let cookie = "";
  let failCommit = false;
  const state = join(root, "state");
  await mkdir(state);
  const link = join(state, "execution-current");
  const tokenPath = join(root, "token");
  await writeFile(tokenPath, "synthetic-token");
  const health = { protocolVersion: 1, pid: 123, codexPid: 456 };
  // Each release reports the store versions its code migrates to when it starts.
  const threadsVersion = { "1.0.0": 1, "1.1.0": 2 };
  const core = createServer((_request, response) => response.end(JSON.stringify(health)));
  const endpoint = join(root, "core.sock");
  await new Promise((done) => core.listen(endpoint, done));
  const gateway = createServer(async (_request, response) => {
    const manifest = JSON.parse(await readFile(join(await readlink(link), "package.json"), "utf8"));
    response.end(
      JSON.stringify({
        ok: true,
        version: manifest.version,
        buildId: manifest.opencraftWeb.buildId,
        core: health,
        storage: [
          {
            name: "threads",
            status: "up-to-date",
            appliedVersion: threadsVersion[manifest.version],
            movedAside: false,
          },
          { name: "tasks", status: "up-to-date", appliedVersion: 5, movedAside: false },
        ],
      }),
    );
  });
  await new Promise((done) => gateway.listen(0, "127.0.0.1", done));
  const restarts = [];
  const execution = createExecutionDeployment({
    link,
    unit: "execution.service",
    coreUnit: "core.service",
    coreEndpoint: endpoint,
    tokenPath,
    healthUrl: `http://127.0.0.1:${gateway.address().port}/health`,
    timeout: 300,
    validate: async () => {},
    prepareAccess: async () => {},
    restart: async () => {
      restarts.push(JSON.parse(await readFile(join(await readlink(link), "package.json"), "utf8")).version);
    },
  });
  const status = async () =>
    parseWebUpdateStatus(await (await fetch(base + "/__opencraft_updates", { headers: { cookie } })).json());
  const post = (action, input = {}) =>
    fetch(base + "/__opencraft_updates/" + action, {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  async function install(version) {
    fixture.select(version);
    await post("check");
    await until(status, (s) => !s.checking && s.latest?.version === version);
    assert.equal((await post("install", { version })).status, 202);
    return until(status, (s) => ["completed", "failed"].includes(s.job?.phase));
  }
  const pointedVersion = async () =>
    JSON.parse(await readFile(join(await readlink(link), "package.json"), "utf8")).version;
  const record = `${link}.storage-versions.json`;
  try {
    fixture = await releaseFixture(root, { execution: true });
    app = await createManagedWebServer({
      initialRelease: fixture.releases.get("1.0.0").packageRoot,
      stateDirectory: state,
      source: fixture.source,
      execution,
      stateWriter: async (path, value) => {
        if (failCommit && value.current.version === "1.1.0") throw new Error("Synthetic disk failure");
        await writeFile(path, JSON.stringify(value));
      },
    });
    base = `http://127.0.0.1:${(await app.listen({ port: 0 })).port}`;
    cookie = (await post("login", { key: (await readFile(app.adminKeyPath, "utf8")).trim() })).headers
      .get("set-cookie")
      .split(";")[0];

    // A normal upgrade records what each release supports.
    const upgraded = await install("1.1.0");
    assert.equal(upgraded.job.phase, "completed");
    assert.equal(await pointedVersion(), "1.1.0");
    const saved = JSON.parse(await readFile(record, "utf8"));
    assert.deepEqual(saved.current, { ":threads": 2, ":tasks": 5 });
    assert.deepEqual(
      Object.values(saved.releases)
        .map((versions) => versions[":threads"])
        .sort(),
      [1, 2],
    );

    // Manual rollback: refused before any pointer change or restart.
    const restartsBefore = restarts.length;
    await post("rollback");
    const refused = await until(status, (s) => s.job?.phase === "failed");
    assert.match(refused.job.error, /rollback refused.*threads v1→v2/);
    assert.match(refused.job.error, /pre-upgrade database snapshots/);
    assert.equal(refused.current.version, "1.1.0");
    assert.equal(await pointedVersion(), "1.1.0");
    assert.equal(restarts.length, restartsBefore);

    // After the operator restores the snapshots and clears the record, rollback proceeds.
    await rm(record);
    await post("rollback");
    const rolledBack = await until(status, (s) => s.job?.phase === "completed" && s.current.version === "1.0.0");
    assert.equal(rolledBack.current.version, "1.0.0");
    assert.equal(await pointedVersion(), "1.0.0");

    // Automatic rollback after a failed commit: the candidate already migrated,
    // so the old backend is not restarted into a newer-schema failure.
    failCommit = true;
    const restartsBeforeFailure = restarts.length;
    const failed = await install("1.1.0");
    assert.equal(failed.job.phase, "failed");
    assert.match(failed.job.error, /Synthetic disk failure; execution rollback failed \(schema-advanced\)/);
    assert.equal(failed.current.version, "1.0.0");
    assert.equal(await pointedVersion(), "1.1.0");
    assert.ok(!restarts.slice(restartsBeforeFailure).includes("1.0.0"), "the old backend was not restarted");
  } finally {
    await app?.close();
    await fixture?.close();
    core.closeAllConnections();
    gateway.closeAllConnections();
    await Promise.all([new Promise((done) => core.close(done)), new Promise((done) => gateway.close(done))]);
    await rm(root, { recursive: true, force: true });
  }
});
