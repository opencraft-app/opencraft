import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openManagedDatabase, resolveStoreMigrations } from "@opencraft/sqlite-node";
import { migrations } from "../../apps/agent-bridge-host/src/migrations.js";
import {
  CodexRollbackHistory,
  openCodexRollbackHistory,
} from "../../apps/opencraft-daemon/src/codex-rollback-history.js";

const server = "server:fixture:codex";
const publicId = "bridge:codex:original";
const nativeId = "ba187d7c-6bec-404b-9aae-ef98ef787a59";

test("rollback reads existing Bridge identities without opening another writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-rollback-test-"));
  const path = join(directory, "engine-host.sqlite");
  try {
    assert.equal((await openCodexRollbackHistory(path, server)).toNative(publicId), undefined);
    const { database } = openManagedDatabase({ path, migrations, schemaId: "agent-bridge-host" });
    try {
      database.exec("INSERT INTO generations(id,config) VALUES ('generation','{}')");
      const route = JSON.stringify([server, publicId]);
      database
        .prepare("INSERT INTO routes(route,generation,archive_state) VALUES (?,'generation','active')")
        .run(route);
      database.prepare("INSERT INTO native_sessions VALUES (?,'generation',?,1)").run(route, nativeId);
      const history = await openCodexRollbackHistory(path, server);
      assert.equal(history.toNative(publicId), nativeId);
      assert.equal(history.toPublic(nativeId), publicId);
      assert.equal(database.prepare("SELECT value FROM meta WHERE key='epoch'").get()?.value, "0");
      assert.equal((await openCodexRollbackHistory(path, "another-server")).toPublic(nativeId), undefined);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a published Bridge store before archive-state migrations opens without migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-rollback-legacy-"));
  const path = join(directory, "engine-host.sqlite");
  try {
    const published = resolveStoreMigrations("agent-bridge-host", migrations).slice(0, 2);
    const { database } = openManagedDatabase({ path, migrations: published });
    try {
      database.exec("INSERT INTO generations(id,config) VALUES ('generation','{}')");
      const route = JSON.stringify([server, publicId]);
      database.prepare("INSERT INTO routes VALUES (?,'generation')").run(route);
      database.prepare("INSERT INTO native_sessions VALUES (?,'generation',?,1)").run(route, nativeId);
      assert.equal((await openCodexRollbackHistory(path, server)).toNative(publicId), nativeId);
      assert.equal(database.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version, 2);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("only a readable public identity reaches Native and the response retains it", () => {
  const history = new CodexRollbackHistory(server, [
    { route: JSON.stringify([server, publicId]), native_id: nativeId, restorable: 1 },
  ]);
  const request = { method: "thread/read", params: { threadId: publicId, includeTurns: false } };
  assert.equal(history.rejection(request.method, request.params), undefined);
  assert.deepEqual(history.nativeRequest(request), { ...request, params: { ...request.params, threadId: nativeId } });
  assert.equal(request.params.threadId, publicId);
  assert.deepEqual(history.publicResponse({ result: { thread: { id: nativeId, name: nativeId } } }, "thread/read"), {
    result: { thread: { id: publicId, name: nativeId } },
  });
  assert.deepEqual(history.publicResponse({ result: { data: [{ id: nativeId }] } }, "thread/list"), {
    result: { data: [{ id: publicId }] },
  });
  for (const id of [
    nativeId,
    nativeId.toUpperCase(),
    nativeId.replaceAll("-", ""),
    `urn:uuid:${nativeId}`,
    "bridge:codex:unknown",
  ]) {
    assert.equal(history.rejection("thread/read", { threadId: id })?.data?.code, "THREAD_NOT_FOUND");
  }
  assert.equal(history.rejection("turn/start", { threadId: publicId })?.data?.notSubmitted, true);
  assert.equal(history.rejection("thread/queue/add", { threadId: publicId })?.data?.notSubmitted, true);
  assert.equal(history.rejection("thread/resume", { threadId: publicId })?.data?.notSubmitted, true);
});
