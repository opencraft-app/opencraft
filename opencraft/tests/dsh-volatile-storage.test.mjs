import assert from "node:assert/strict";
import test from "node:test";
import { VolatileSessions, routeSessionPersistence, routeProjectionCache } from "../apps/local-agent-host/src/dsh-thread-storage.mjs";

test("volatile session history and projection checkpoints never reach durable backends", async () => {
  let writes = 0;
  class Durable {
    async appendBatch() { writes++; }
    async loadStored() { return undefined; }
    async readStoredRevision() { return undefined; }
    locate() { return { path: "/durable" }; }
    async put() { writes++; }
  }
  const sessions = new VolatileSessions(); sessions.mark("temporary");
  const Persistence = routeSessionPersistence(Durable, sessions);
  const p = new Persistence();
  await p.appendBatch({ id: "temporary", cwd: "/tmp" }, [{ seq: 0, type: "test", data: { exact: "history" } }], false);
  const first = await p.loadStored("temporary");
  assert.equal(first.events[0].data.exact, "history");
  first.events[0].data.exact = "mutated";
  assert.equal((await p.loadStored("temporary")).events[0].data.exact, "history");
  assert.equal(p.locate({ id: "temporary" }), undefined);
  const Cache = routeProjectionCache(Durable, sessions); await new Cache().put("temporary", {}, {});
  assert.equal(writes, 0);
  await p.appendBatch({ id: "durable" }, [], false); assert.equal(writes, 1);
  sessions.forget("temporary"); assert.equal(await p.loadStored("temporary"), undefined);
});
