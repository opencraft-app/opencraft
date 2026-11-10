import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurablePiOwnerFactory } from "../../plugins/pi-bridge/src/owner.js";
import { PiSessionOpenError } from "../../plugins/pi-bridge/src/types.js";

const MODELS = JSON.stringify({
  providers: {
    test: {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: "unused",
      models: [{
        id: "model",
        name: "Test Model",
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  },
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-bridge-owner-"));
  await writeFile(join(dir, "models.json"), MODELS, { mode: 0o600 });
  await writeFile(join(dir, "auth.json"), "{}", { mode: 0o600 });
  const factory = new DurablePiOwnerFactory({ dataDir: dir, agentDirectory: dir, lockRetries: 0 });
  return { dir, factory };
}

test("one bridge Thread has one durable owner; create refuses adoption and resume refuses a live writer", async (t) => {
  const { dir, factory } = await fixture();
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const routeId = JSON.stringify(["server", "thread"]);
  const owner = await factory.create({ routeId, cwd: dir, model: "test/model" });
  t.after(async () => { await factory.close(owner).catch(() => {}); });
  assert.match(owner.info.nativeSessionId, /^pi_bridge_[0-9a-f-]{36}$/u);
  const snapshot = await owner.snapshot();
  assert.equal(snapshot.turns.length, 0);
  assert.equal(snapshot.activeTurnId, null);

  const sessions = join(dir, "sessions");
  const entries = await readdir(sessions);
  const metadata = entries.find(name => name.endsWith(".json"));
  const database = entries.find(name => name.endsWith(".sqlite"));
  assert.ok(metadata && database, "bridge writes one metadata file and one native SQLite file");
  const record = JSON.parse(await readFile(join(sessions, metadata), "utf8")) as { routeId: string; nativeSessionId: string; state: string };
  assert.equal(record.routeId, routeId);
  assert.equal(record.nativeSessionId, owner.info.nativeSessionId);
  assert.equal(record.state, "active");
  assert.ok((await stat(join(sessions, database))).size > 0, "the native durable session is a real non-empty database");

  // A second create must not adopt the existing file, and a live resume must
  // fail on the native owner lock rather than open a second writer.
  await assert.rejects(factory.create({ routeId, cwd: dir, model: "test/model" }),
    (error: unknown) => error instanceof PiSessionOpenError && error.failure === "exists");
  await assert.rejects(factory.resume({ routeId }),
    (error: unknown) => error instanceof PiSessionOpenError && error.failure === "locked");

  await factory.close(owner);
  const resumed = await factory.resume({ routeId });
  assert.equal(resumed.info.nativeSessionId, owner.info.nativeSessionId);
  assert.equal((await resumed.snapshot()).turns.length, 0);
  await factory.close(resumed);

  // Simulate a crash after native open but before active metadata: the pending
  // reservation is recoverable by resume, never by a second create.
  const pending = { ...record, state: "pending" };
  await writeFile(join(sessions, metadata), JSON.stringify(pending), { mode: 0o600 });
  await assert.rejects(factory.create({ routeId, cwd: dir, model: "test/model" }),
    (error: unknown) => error instanceof PiSessionOpenError && error.failure === "pending");
  const recovered = await factory.resume({ routeId });
  assert.equal(JSON.parse(await readFile(join(sessions, metadata), "utf8")).state, "active");
  await factory.close(recovered);

  // A resume must never recreate a deleted native database as an empty writer.
  await rm(join(sessions, database));
  await assert.rejects(factory.resume({ routeId }),
    (error: unknown) => error instanceof PiSessionOpenError && error.failure === "missing");
});

test("resume refuses a thread that the bridge never owned", async (t) => {
  const { dir, factory } = await fixture();
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await assert.rejects(factory.resume({ routeId: JSON.stringify(["server", "missing"]) }),
    (error: unknown) => error instanceof PiSessionOpenError && error.failure === "missing");
});
