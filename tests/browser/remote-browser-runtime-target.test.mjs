import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteBrowserService } from "../../scripts/remote-browser-service.mjs";
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "browser-target-"));
  const calls = { spawn: 0, attach: 0 };
  const service = new RemoteBrowserService({
    root: directory,
    dataDirectory: directory,
    spawnImpl() {
      calls.spawn++;
      throw Error("local spawn forbidden");
    },
    ownerConnector: async () => {
      calls.attach++;
      throw Error("attach not part of readiness");
    },
    ...options,
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, calls };
}
test("remote owner readiness does not require a Gateway Electron installation or attach the owner", async (t) => {
  let checks = 0;
  const { service, calls } = await fixture(t, {
    ownerAvailable: async () => {
      checks++;
      return true;
    },
  });
  assert.equal(await service.available(), true);
  assert.equal(checks, 1);
  assert.deepEqual(calls, { spawn: 0, attach: 0 });
  await service.close();
  assert.equal(await service.available(), false);
  assert.equal(checks, 1);
});
test("missing local runtime retains legacy unavailable result without a remote probe", async (t) => {
  const { service, calls } = await fixture(t);
  assert.equal(await service.available(), false);
  assert.deepEqual(calls, { spawn: 0, attach: 0 });
});
test("negative, invalid or failed readiness never falls back to local execution", async (t) => {
  for (const probe of [
    async () => false,
    async () => "true",
    async () => {
      throw Error("expired remote lease");
    },
  ]) {
    const { service, calls } = await fixture(t, { ownerAvailable: probe });
    assert.equal(await service.available(), false);
    // Isolate the startup/native-dispatch boundary: durable loading is tested in
    // the existing state-store suite, not replaced by this test in production.
    service.load = async () => {};
    await assert.rejects(service.start(), /runtime unavailable/);
    assert.deepEqual(calls, { spawn: 0, attach: 0 });
  }
});
test("closing while readiness waits cannot report success or attach a late owner", async (t) => {
  let settle, started;
  const began = new Promise((resolve) => (started = resolve));
  const { service, calls } = await fixture(t, {
    ownerAvailable: () => {
      started();
      return new Promise((resolve) => (settle = resolve));
    },
  });
  service.load = async () => {};
  const starting = service.start();
  await began;
  await service.close();
  settle(true);
  await assert.rejects(starting, /closed/);
  assert.deepEqual(calls, { spawn: 0, attach: 0 });
});
test("remote readiness cannot enable a direct local Electron spawn configuration", () => {
  assert.throws(
    () =>
      new RemoteBrowserService({
        root: "/unused",
        dataDirectory: "/unused",
        ownerConnector: null,
        ownerAvailable: async () => true,
      }),
    /private browser owner connector/,
  );
});

test("remote-target startup loads real browser storage and attaches only the supplied owner", async (t) => {
  let attaches = 0,
    detaches = 0;
  const peer = Object.assign(new EventEmitter(), {
    connected: true,
    inventory: [],
    workerPid: 123,
    automationCancellation: 1,
    automationNavigation: 1,
    kill() {
      detaches++;
    },
    send() {
      throw Error("empty inventory requires no native command");
    },
  });
  const { service, calls } = await fixture(t, {
    ownerAvailable: async () => true,
    ownerConnector: async () => {
      attaches++;
      return peer;
    },
  });
  await service.start();
  assert.equal(attaches, 1);
  assert.equal(calls.spawn, 0);
  assert.strictEqual(service.child, peer);
  assert.ok(service.store.outcome);
  assert.equal(service.store.current.pages.length, 0);
  await service.start();
  assert.equal(attaches, 1);
  await service.close();
  assert.ok(detaches > 0);
});

test("readiness from a replaced owner connector cannot authorize its successor", async (t) => {
  let settle;
  const { service } = await fixture(t, { ownerAvailable: () => new Promise((resolve) => (settle = resolve)) });
  const ready = service.available();
  service.ownerConnector = async () => {
    throw Error("successor");
  };
  settle(true);
  assert.equal(await ready, false);
});

for (const complete of [false, true, undefined])
  test(`inventory completeness ${complete} preserves unobserved native reservations appropriately`, async (t) => {
    const peer = Object.assign(new EventEmitter(), {
      inventory: [],
      inventoryComplete: complete,
      kill() {},
      send() {
        throw Error("inventory must not create or contact an unobserved page");
      },
    });
    const { service } = await fixture(t, { ownerAvailable: async () => true, ownerConnector: async () => peer });
    await service.load();
    const records = ["unknown", "live", "absent"].map((kind, index) => {
      const key = JSON.stringify(["owner", "inventory-" + index]);
      return {
        id: createHash("sha256").update(key).digest("hex"),
        key,
        ownerId: "owner",
        lifecycle: "open",
        zoom: 100,
        runtime: { kind, generation: 1 },
      };
    });
    await service.commit((draft) => {
      draft.pages.push(...records);
    });
    for (const record of records) service.pages.set(record.key, { ...record, live: false });
    // Completeness belongs to the attachment, not a mutable later peer property.
    const commit = service.commit.bind(service);
    service.commit = (reduce, options) => {
      peer.inventoryComplete = !complete;
      return commit(reduce, options);
    };
    await service.start();
    assert.deepEqual(
      service.store.current.pages.map((p) => p.runtime.kind),
      complete === false ? ["unknown", "unknown", "absent"] : ["absent", "absent", "absent"],
    );
    assert.equal((await service.catalog("owner", () => {})).capacity.accountUsed, complete === false ? 2 : 0);
  });

test("partial inventory adopts observed pages without freeing unobserved reservations", async (t) => {
  const peer = Object.assign(new EventEmitter(), { inventoryComplete: false, inventory: [], kill() {} });
  const { service } = await fixture(t, { ownerAvailable: async () => true, ownerConnector: async () => peer });
  await service.load();
  const key = JSON.stringify(["owner", "observed"]),
    id = createHash("sha256").update(key).digest("hex");
  await service.commit((draft) =>
    draft.pages.push({
      id,
      key,
      ownerId: "owner",
      lifecycle: "open",
      zoom: 100,
      runtime: { kind: "unknown", generation: 1 },
    }),
  );
  service.pages.set(key, { id, key, ownerId: "owner", live: false });
  peer.inventory = [
    { id, document: "existing-document", width: 800, height: 600, navigation: { url: "https://example.test/" } },
  ];
  await service.start();
  assert.equal(service.pages.get(key).document, "existing-document");
  assert.equal(service.store.current.pages[0].runtime.kind, "live");
  assert.equal((await service.catalog("owner", () => {})).capacity.accountUsed, 1);
});

test("malformed inventory completeness fails closed and detaches the exact peer", async (t) => {
  let detached = 0;
  const peer = Object.assign(new EventEmitter(), {
    inventory: [],
    inventoryComplete: "false",
    kill() {
      detached++;
    },
  });
  const { service } = await fixture(t, { ownerAvailable: async () => true, ownerConnector: async () => peer });
  await assert.rejects(service.start(), /Invalid browser owner inventory completeness/);
  assert.equal(service.child, null);
  assert.equal(detached, 1);
});
