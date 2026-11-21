import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDatabase } from "@opencraft/sqlite-node";
import { openServerDatabase, SERVER_MIGRATIONS } from "@opencraft/storage-node/server";
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";

test("v19 source rows and ledger upgrade unchanged into the legacy connection scope", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "connection-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = SERVER_MIGRATIONS.slice(0, 19);
  assert.equal(previous.at(-1)!.name, "0018_native_group_lifecycle");
  const old = openManagedDatabase({
    path: join(directory, "opencraft-server.sqlite"),
    migrations: previous,
    legacyPolicy: "reject",
  });
  old.database
    .prepare("INSERT INTO actor_channels(id,owner_id,title) VALUES('old-group','old-owner','Old group')")
    .run();
  old.database
    .prepare("INSERT INTO actor_channel_sources VALUES('old-source','old-group','old-epoch','old-incarnation',1,1)")
    .run();
  const before = old.database.prepare("SELECT * FROM actor_channel_sources").all();
  const ledger = old.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  old.database.close();
  const storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  try {
    assert.deepEqual(storage.database.prepare("SELECT * FROM actor_channel_sources").all(), before);
    assert.deepEqual(
      storage.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all().slice(0, 19),
      ledger,
    );
    assert.equal(storage.database.prepare("SELECT count(*) AS n FROM actors").get()!.n, 0);
    const configure = (connectionId?: string) =>
      service.synchronizeChannels({
        method: "configure",
        params: {
          incarnation: "new",
          ...(connectionId ? { connectionId } : {}),
          bindings: [{ source: "old-source", channelId: "old-group" }],
          images: true,
        },
      });
    await assert.rejects(configure("new-adapter"), /connection_conflict/);
    await configure();
    assert.equal(
      storage.database.prepare("SELECT connection_id FROM actor_channel_source_owners").get()!.connection_id,
      "legacy",
    );
    assert.equal(storage.database.prepare("SELECT epoch FROM actor_channel_sources").get()!.epoch, "old-epoch");
    assert.equal(await service.synchronizeChannels({ method: "claim", params: { incarnation: "new" } }), null);
    assert.equal(storage.database.prepare("SELECT count(*) AS n FROM actors").get()!.n, 0);
  } finally {
    await service.close();
    actors.close();
    await storage.close();
  }
});
