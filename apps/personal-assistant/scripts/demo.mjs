import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { initProfile } from "../src/profile.mjs";
import { request } from "../src/runner.mjs";

const root = resolve(import.meta.dirname, ".."),
  evidence = join(root, "evidence");
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const path = process.argv[2] ? resolve(process.argv[2]) : join(root, "profiles", `demo-${Date.now()}`);
if (existsSync(join(path, "profile.json"))) throw new Error("Demo requires a fresh profile directory");
const profile = initProfile(path, "local:demo", { fixtureDelayMs: 300 });
const transcript = [];
const call = async (op, params = {}, id = crypto.randomUUID()) => {
  const result = await request(profile, { op, id, params });
  transcript.push({ op, id, params, result });
  return result;
};
async function start() {
  const child = spawn(process.execPath, ["bin/assistant.mjs", "run", "--profile", path], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    error = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (error += c));
  const exit = once(child, "exit");
  for (let i = 0; i < 200; i++) {
    if (output.includes('"event":"ready"')) return { child, exit };
    if (child.exitCode !== null) throw new Error(error);
    await delay(50);
  }
  child.kill("SIGTERM");
  throw new Error("Demo runner did not become ready");
}
async function done(id) {
  for (let i = 0; i < 200; i++) {
    const detail = await request(profile, {
      op: "work",
      params: { workId: id },
    });
    if (detail.work.status === "blocked") throw new Error(detail.work.error);
    if (detail.work.status === "completed") return detail;
    await delay(50);
  }
  throw new Error("Demo work did not complete");
}
let handle;
try {
  handle = await start();
  await call("memory.set", { key: "city", value: "上海" }, "demo-city");
  const work = await call("submit", { text: "根据个人资料整理一份本地项目跟进笔记" }, "demo-work");
  await call("status");
  await call(
    "amend",
    {
      workId: work.workId,
      text: "只整理本周进展，保留待跟进事项",
      expectedRevision: 1,
    },
    "demo-amend",
  );
  const beforeRestart = await done(work.workId);
  handle.child.kill("SIGTERM");
  await handle.exit;
  handle = await start();
  const receipt = await call("submit", { text: "根据个人资料整理一份本地项目跟进笔记" }, "demo-work");
  assert.equal(receipt.duplicate, true);
  await call(
    "routine.add",
    {
      text: "执行一次本地进展检查",
      intervalMs: 1000,
      startAt: Date.now(),
      maxRuns: 1,
    },
    "demo-routine",
  );
  const end = Date.now() + 10000;
  let scheduled;
  while (!scheduled && Date.now() < end) {
    scheduled = (await request(profile, { op: "status", params: {} })).works.find((w) => w.source === "routine");
    if (!scheduled) await delay(50);
  }
  assert.ok(scheduled);
  await done(scheduled.id);
  const status = await call("status"),
    events = await call("events");
  const result = {
    date: new Date().toISOString(),
    profile: path,
    modelMode: "deterministic-fixture",
    piVersion: "1.3.0",
    assertions: {
      amendedSameWork: beforeRestart.work.revision === 2,
      restartRetainsInputIdentity: receipt.duplicate,
      routineRanOnce: status.routines[0].created_count === 1,
      localMailboxCount: readdirSync(join(path, "mailbox")).length,
    },
    status,
    transcript,
    events,
  };
  const target = join(evidence, "demo.json");
  writeFileSync(target, JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify({ evidence: target, profile: path, assertions: result.assertions }, null, 2));
} finally {
  if (handle?.child.exitCode === null && handle?.child.signalCode === null) {
    handle.child.kill("SIGTERM");
    await handle.exit;
  }
}
