import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { initProfile } from "../src/profile.mjs";
import { Runner, request } from "../src/runner.mjs";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

export const root = resolve(import.meta.dirname, "..");
function temporaryProfile(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sa-runner-test-"));
  return initProfile(directory, "local:test-owner", {
    memoryPolicy: { debounceMs: 0 },
    memoryDefaultScope: "user",
    ...options,
  });
}
export function profileFor(t, options = {}) {
  const profile = temporaryProfile(options);
  t.after(() => rm(profile.path, { recursive: true, force: true }));
  return profile;
}
export async function running(t, options = {}) {
  const profile = temporaryProfile(options);
  let runner;
  try {
    runner = await Runner.open(profile);
  } catch (error) {
    await rm(profile.path, { recursive: true, force: true });
    throw error;
  }
  t.after(async () => {
    try {
      await runner.close();
    } finally {
      await rm(profile.path, { recursive: true, force: true });
    }
  });
  return {
    profile,
    runner,
    call: (op, params = {}, id = crypto.randomUUID()) => request(profile, { op, params, id }),
  };
}
export async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("Condition timed out");
    await delay(25);
  }
}
export async function completed(profile, id) {
  return until(async () => {
    const w = await request(profile, { op: "work", params: { workId: id } });
    if (w.work.status === "blocked") throw new Error(`Work blocked: ${w.work.error}`);
    return w.work.status === "completed" && w;
  });
}
export function files(profile, folder) {
  return readdirSync(join(profile.path, folder)).filter((name) => !name.startsWith("."));
}
export async function childRunner(t, profile, env = {}) {
  const child = spawn(process.execPath, ["bin/assistant.mjs", "run", "--profile", profile.path], {
    cwd: root,
    env: {
      ...process.env,
      LAB_TEST_CRASH_AT: "",
      LAB_TEST_DELIVERY_FAIL: "",
      LAB_TEST_TOOL_PAUSE_MS: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const exited = once(child, "exit").then(([code, signal]) => ({
    code,
    signal,
  }));
  const handle = {
    child,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop(signal = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode !== null) return exited;
      child.kill(signal);
      const forced = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        return await exited;
      } finally {
        clearTimeout(forced);
      }
    },
  };
  t.after(() => handle.stop());
  await until(() => {
    if (child.exitCode !== null) throw new Error(`Runner exited ${child.exitCode}: ${stderr}`);
    return stdout.includes('"event":"ready"');
  }, 17000);
  return handle;
}
export async function nativeEntries(profile, workId) {
  const storage = await openNodeSqliteStorage(join(profile.path, "executions", `${workId}.sqlite`));
  try {
    const conversations = await storage.scanConversations({}, 100, undefined, context);
    const entries = [];
    for (const conversation of conversations.items)
      entries.push(
        ...(await storage.scanEntries({ conversationId: conversation.id }, 10000, undefined, context)).items,
      );
    return entries;
  } finally {
    await storage.close(context);
  }
}

export async function publishTestNote(store, work, body) {
  const { LocalArtifactStore } = await import("../src/adapters/filesystem/artifact-store.mjs");
  const artifact = new LocalArtifactStore(join(store.profile.path, "artifacts")).publishNote(
    store.app.executionLedger.get(work).id,
    body,
  );
  store.app.completion.publishedNote(work, artifact, body);
  return artifact;
}

// A historical fixture must remove the later file authority as well as later SQL tables.
export function legacyMemoryFixture(profile, db) {
  legacyCoordinationFixture(db);
  rmSync(join(profile.path, "memory-space"), { recursive: true, force: true });
  db.exec(
    "DROP TABLE IF EXISTS user_message; ALTER TABLE delivery DROP COLUMN user_message_json; ALTER TABLE notification DROP COLUMN user_message_json; DROP TABLE IF EXISTS conversation_context; DROP TABLE memory_shard; DROP TABLE memory_file_state; DROP TABLE memory_file_commit;",
  );
}

export function legacyCoordinationFixture(db) {
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec(`DROP TABLE IF EXISTS execution_dependency; DROP TABLE IF EXISTS work_dependency; DROP TABLE IF EXISTS goal_work; DROP TABLE IF EXISTS goal; DROP TABLE IF EXISTS work_directive;
      ALTER TABLE work DROP COLUMN active_execution_id;
      CREATE TABLE execution_old(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES work(id),revision INTEGER NOT NULL,input_id TEXT NOT NULL,status TEXT NOT NULL,submission_id TEXT,conversation_id TEXT,context_json TEXT,request_json TEXT,guard_json TEXT,harness TEXT NOT NULL DEFAULT 'pi' CHECK(harness IN ('pi','codex')),UNIQUE(work_id,revision));
      INSERT INTO execution_old SELECT id,work_id,revision,input_id,status,submission_id,conversation_id,context_json,request_json,guard_json,harness FROM execution;
      DROP TABLE execution; ALTER TABLE execution_old RENAME TO execution;`);
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
