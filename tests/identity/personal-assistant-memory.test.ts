import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";
import { createPersonalAssistantHost } from "../../apps/personal-assistant/src/runtime/host-supervisor.mjs";
async function until(f: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Host not ready");
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "memory-owner-")),
    db = await openServerDatabase(directory),
    actors = new ActorStore(db),
    service = new Collaboration(db, actors);
  const human = (name: string) =>
    actors.resolveHuman({
      provider: "local",
      subject: name,
      displayName: name,
      expiresAt: Date.now() + 60000,
    })!;
  const alice = human("alice"),
    bob = human("bob");
  let host: any,
    enabled = true;
  t.after(async () => {
    await host?.close();
    await service.close();
    actors.close();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    disable: () => {
      enabled = false;
    },
    pause: async (id: string) => {
      enabled = false;
      await until(() => host.state(id).phase === "config_required");
    },
    directory,
    actors,
    service,
    alice,
    bob,
    start: async () =>
      (host = await createPersonalAssistantHost({
        directory,
        service,
        readConfig: async () =>
          !enabled
            ? null
            : {
                maxRuntimes: 2,
                profileOptions: {
                  mode: "fixture",
                  telemetry: { enabled: false },
                },
              },
        intervalMs: 25,
      })),
  };
}
test("real Human RPC and isolated Host browse, correct and forget only the current private memory", async (t) => {
  const f = await fixture(t),
    a = await f.service.personalAssistant(
      f.alice,
      "opencraft/personal-assistant/claim",
    ),
    b = await f.service.personalAssistant(
      f.bob,
      "opencraft/personal-assistant/claim",
    ),
    host = await f.start();
  await until(
    () =>
      host.state(a.assistant.binding.botId).phase === "running" &&
      host.state(b.assistant.binding.botId).phase === "running",
  );
  const folder = join(f.directory, "bots", a.assistant.binding.botId, "memory");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "profile.md"),
    "# 私有档案\n\n这是一段普通说明，不是记忆。\n\n- (2026-11-14) Alice 私有偏好\n",
  );
  const call = (c: any, binding: any, p: any) =>
    f.service.personalAssistant(c, "opencraft/personal-assistant/memory", {
      botId: binding.botId,
      assignmentId: binding.assignmentId,
      ...p,
    });
  const list = await call(f.alice, a.assistant.binding, { action: "list" });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].value, "Alice 私有偏好");
  assert.equal(
    (await call(f.bob, b.assistant.binding, { action: "list" })).items.length,
    0,
  );
  await assert.rejects(
    call(f.bob, a.assistant.binding, { action: "list" }),
    /changed/,
  );
  await assert.rejects(
    call(f.alice, a.assistant.binding, {
      action: "list",
      owner: f.bob.actorId,
    }),
    /unexpected_field/,
  );
  const doc = await call(f.alice, a.assistant.binding, {
    action: "file",
    path: "profile.md",
  });
  assert.match(doc.content, /普通说明/);
  assert.ok(!JSON.stringify(list).includes("普通说明"));
  assert.equal(
    (
      await call(f.alice, a.assistant.binding, {
        action: "file",
        path: "../profile.json",
      })
    ).code,
    "invalid",
  );
  const item = list.items[0],
    p = {
      action: "set",
      key: item.key,
      value: "Alice 新偏好",
      expectedRevision: item.revision,
      requestId: "owner-edit-0001",
    };
  const changed = await call(f.alice, a.assistant.binding, p);
  assert.equal(
    (await call(f.alice, a.assistant.binding, p)).revision,
    changed.revision,
  );
  assert.equal(
    (await call(f.alice, a.assistant.binding, { action: "list" })).items[0]
      .value,
    "Alice 新偏好",
  );
  const forgotten = await call(f.alice, a.assistant.binding, {
    action: "forget",
    key: item.key,
    expectedRevision: changed.revision,
    requestId: "owner-forget-0001",
  });
  assert.ok(forgotten.revision > changed.revision);
  assert.equal(
    (await call(f.alice, a.assistant.binding, { action: "list" })).items.length,
    0,
  );
  const provision = await f.service.provisionPersonalAssistant(f.alice),
    bot = f.actors.authenticateSession(provision.credential.token)!;
  await assert.rejects(
    call(bot, a.assistant.binding, { action: "list" }),
    /denied/,
  );
  await f.service.personalAssistant(
    f.alice,
    "opencraft/personal-assistant/revoke",
  );
  await assert.rejects(
    call(f.alice, a.assistant.binding, { action: "list" }),
    /denied/,
  );
});
test("a delayed memory read never returns data after revoke/reclaim", async (t) => {
  const f = await fixture(t),
    claimed = await f.service.personalAssistant(
      f.alice,
      "opencraft/personal-assistant/claim",
    ),
    held = Promise.withResolvers<any>(),
    started = Promise.withResolvers<void>();
  const detach = f.service.attachPersonalAssistantHost({
    state: () => ({ phase: "running" }),
    wake() {},
    memory: async () => {
      started.resolve();
      return held.promise;
    },
  });
  t.after(detach);
  const binding = claimed.assistant.binding,
    read = f.service.personalAssistant(
      f.alice,
      "opencraft/personal-assistant/memory",
      {
        botId: binding.botId,
        assignmentId: binding.assignmentId,
        action: "list",
      },
    );
  await started.promise;
  await f.service.personalAssistant(
    f.alice,
    "opencraft/personal-assistant/revoke",
  );
  await f.service.personalAssistant(
    f.alice,
    "opencraft/personal-assistant/claim",
  );
  held.resolve({
    action: "list",
    items: [{ value: "must not escape" }],
    next: null,
  });
  await assert.rejects(read, /changed/);
});

test("configured-off Host reads original facts and prose documents without starting or modifying a runner", async (t) => {
  const f = await fixture(t),
    claimed = await f.service.personalAssistant(
      f.alice,
      "opencraft/personal-assistant/claim",
    ),
    binding = claimed.assistant.binding,
    host = await f.start();
  await until(() => host.state(binding.botId).phase === "running");
  const profile = join(f.directory, "bots", binding.botId),
    folder = join(profile, "memory");
  await mkdir(join(folder, "log"), { recursive: true });
  await writeFile(
    join(folder, "profile.md"),
    "# 私有档案\n\n- (2026-11-14) 离线也能看见的偏好\n",
  );
  await writeFile(
    join(folder, "log", "2026-01.md"),
    "# 只有普通段落\n没有事实行也应可浏览。\n",
  );
  const call = (p: any) =>
    f.service.personalAssistant(
      f.alice,
      "opencraft/personal-assistant/memory",
      { botId: binding.botId, assignmentId: binding.assignmentId, ...p },
    );
  const live = await call({ action: "list" });
  assert.equal(live.writable, true);
  await f.pause(binding.botId);
  const { readFile, readdir, symlink, unlink } = await import(
      "node:fs/promises"
    ),
    { createHash } = await import("node:crypto");
  async function fingerprint(path: string): Promise<any> {
    const files: any = [];
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const at = join(path, entry.name);
      if (entry.isDirectory()) files.push([entry.name, await fingerprint(at)]);
      else
        files.push([
          entry.name,
          createHash("sha256")
            .update(await readFile(at))
            .digest("hex"),
        ]);
    }
    return files;
  }
  const before = await fingerprint(profile),
    off = await call({ action: "list" });
  assert.equal(off.writable, false);
  assert.equal(off.version, live.version);
  assert.equal(off.items[0].value, "离线也能看见的偏好");
  const docs = await call({ action: "documents" });
  assert.equal(docs.total, 2);
  assert.equal(
    docs.items.find((d: any) => d.path === "log/2026-01.md").facts,
    0,
  );
  assert.match(
    (await call({ action: "file", path: "log/2026-01.md" })).content,
    /普通段落/,
  );
  assert.equal((await call({ action: "status" })).version, live.version);
  assert.deepEqual(await fingerprint(profile), before);
  assert.equal(
    (
      await call({
        action: "set",
        key: off.items[0].key,
        value: "不允许离线写",
        expectedRevision: off.items[0].revision,
        requestId: "offline-write-0001",
      })
    ).code,
    "offline",
  );
  const { readOfflineMemory } = await import(
    "../../apps/personal-assistant/src/runtime/memory-browser-offline.mjs"
  );
  assert.equal(
    readOfflineMemory(
      f.directory,
      { ...binding, owner: { kind: "human", id: f.bob.actorId } },
      { action: "list" },
    ).code,
    "storage",
  );
  await mkdir(join(profile, ".transactions"), { recursive: true });
  await writeFile(join(profile, ".transactions", "pending.json"), "{}");
  assert.equal((await call({ action: "list" })).code, "recovery_required");
  assert.equal(
    await readFile(join(profile, ".transactions", "pending.json"), "utf8"),
    "{}",
  );
  await unlink(join(profile, ".transactions", "pending.json"));
  await mkdir(join(profile, ".write-lock"));
  await writeFile(
    join(profile, ".write-lock", "owner.json"),
    JSON.stringify({ pid: process.pid }),
  );
  assert.equal((await call({ action: "list" })).code, "busy");
  assert.match(
    await readFile(join(profile, ".write-lock", "owner.json"), "utf8"),
    /pid/,
  );
  await rm(join(profile, ".write-lock"), { recursive: true });
  await writeFile(join(f.directory, "outside.md"), "must not escape");
  await symlink(
    join(f.directory, "outside.md"),
    join(folder, "log", "2026-02.md"),
  );
  assert.equal((await call({ action: "documents" })).code, "storage");
  await unlink(join(folder, "log", "2026-02.md"));
  await assert.rejects(
    f.service.personalAssistant(f.bob, "opencraft/personal-assistant/memory", {
      botId: binding.botId,
      assignmentId: binding.assignmentId,
      action: "list",
    }),
  );
});

test("offline source evidence is a SELECT-only identity-bound projection, not a new database writer", async (t) => {
  const f = await fixture(t),
    claimed = await f.service.personalAssistant(
      f.alice,
      "opencraft/personal-assistant/claim",
    ),
    binding = claimed.assistant.binding,
    host = await f.start();
  await until(() => host.state(binding.botId).phase === "running");
  await f.pause(binding.botId);
  const { DatabaseSync } = await import("node:sqlite"),
    { readFile } = await import("node:fs/promises");
  const profile = join(f.directory, "bots", binding.botId),
    db = new DatabaseSync(join(profile, "assistant.sqlite"));
  // Seed an offline fixture; no runtime writer exists now. Production reader never executes these writes.
  const assistantId = binding.botId,
    conversationId = "offline-evidence-conversation";
  const table = db.prepare("PRAGMA table_info(conversation)").all();
  assert.ok(table.length);
  const existing: any = db
    .prepare("SELECT id FROM conversation WHERE assistant_id=? LIMIT 1")
    .get(assistantId);
  assert.ok(existing);
  const columns = db
    .prepare("PRAGMA table_info(conversation_message)")
    .all()
    .map((r: any) => r.name);
  const msg: any = {
    id: "offline-source",
    conversation_id: existing.id,
    role: "user",
    text: "最初的来源文字",
    at: Date.now(),
    source_id: "offline-source",
    input_id: "offline-source",
    data: "{}",
  };
  const sqlColumns = columns.filter((c: any) => c in msg);
  db.prepare(
    "INSERT INTO conversation_message (" +
      sqlColumns.join(",") +
      ") VALUES (" +
      sqlColumns.map(() => "?").join(",") +
      ")",
  ).run(...sqlColumns.map((c: any) => msg[c]));
  db.close();
  // Create the memory using the original parser format and its existing provenance sidecar.
  const folder = join(profile, "memory");
  await writeFile(
    join(folder, "profile.md"),
    "- (2026-11-14) 来源对应的事实\n",
  );
  const { readOfflineMemory } = await import(
    "../../apps/personal-assistant/src/runtime/memory-browser-offline.mjs"
  );
  let list: any = readOfflineMemory(f.directory, binding, { action: "list" });
  const item = list.items[0];
  const path = join(folder, ".dreaming", "records.json"),
    records = JSON.parse(
      await readFile(path, "utf8").catch((e: any) => {
        if (e.code === "ENOENT") return '{"records":[]}';
        throw e;
      }),
    );
  records.records.push({
    key: item.key,
    revision: 1,
    updatedAt: Date.parse("2026-11-14T00:00:00Z"),
    input_id: "fixture-source",
    deleted: false,
    kind: "profile",
    origin: "automatic",
    contentId: item.key.split("fact_").at(-1),
    evidenceIds: ["offline-source"],
  });
  // contentId is obtained from the canonical value function, never guessed from opaque keys.
  const { fileContentId } = await import(
    "../../apps/personal-assistant/src/adapters/memory/file-store.mjs"
  );
  records.records.at(-1).contentId = fileContentId(item.value);
  await mkdir(join(folder, ".dreaming"), { recursive: true });
  await writeFile(path, JSON.stringify(records));
  const source: any = readOfflineMemory(f.directory, binding, {
    action: "sources",
    key: item.key,
  });
  assert.equal(source.sources[0].text, "最初的来源文字");
});

test("offline browse does not initialize an unprovisioned profile", async (t) => {
  const f = await fixture(t),
    claimed = await f.service.personalAssistant(
      f.alice,
      "opencraft/personal-assistant/claim",
    );
  f.disable();
  const host = await f.start(),
    b = claimed.assistant.binding;
  await until(() => host.state(b.botId).phase === "config_required");
  const result = await f.service.personalAssistant(
    f.alice,
    "opencraft/personal-assistant/memory",
    { botId: b.botId, assignmentId: b.assignmentId, action: "list" },
  );
  assert.equal(result.code, "not_provisioned");
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(f.directory, "bots", b.botId)), false);
});
