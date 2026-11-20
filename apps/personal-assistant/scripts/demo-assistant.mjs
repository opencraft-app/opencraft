import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { initProfile } from "../src/adapters/local/profile.mjs";
import { request } from "../src/adapters/local/unix-socket.mjs";

const root = resolve(import.meta.dirname, ".."),
  path = join(root, "profiles", `assistant-${Date.now()}`);
const profile = initProfile(path, "local:assistant-demo", {
  workspace: join(root, "examples/materials"),
  fixtureDelayMs: 250,
});
const transcript = [];
const cli = (...args) => {
  const value = JSON.parse(
    execFileSync(
      process.execPath,
      ["bin/assistant.mjs", ...args, "--profile", path],
      { cwd: root, encoding: "utf8", timeout: 5000 },
    ),
  );
  transcript.push({ args, value });
  return value.result;
};
async function until(check) {
  const end = Date.now() + 15000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("Demo condition timed out");
    await delay(50);
  }
}
const call = (op, params = {}) => request(profile, { op, params });
async function waitTurn(id) {
  return until(async () => {
    const turn = await call("turn", { inputId: id });
    if (turn.status === "blocked") throw new Error(turn.reply_text);
    return turn.status === "settled" && turn;
  });
}
async function start() {
  const child = spawn(
    process.execPath,
    ["bin/assistant.mjs", "run", "--profile", path],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const exited = once(child, "exit");
  await until(() => {
    if (child.exitCode !== null) throw new Error(stderr);
    return stdout.includes('"event":"ready"');
  });
  return { child, exited };
}
let handle;
try {
  handle = await start();
  cli("say", "--text", "你好", "--id", "hello");
  await waitTurn("hello");
  assert.equal((await call("status")).works.length, 0);
  cli("say", "--text", "整理项目资料，列出进展和待跟进事项", "--id", "project");
  const accepted = await waitTurn("project");
  cli("say", "--text", "查进度", "--id", "progress");
  await waitTurn("progress");
  await until(async () => {
    const work = await call("work", { workId: accepted.work_id });
    if (work.work.status === "blocked") throw new Error(work.work.error);
    return work.work.status === "completed";
  });
  const before = cli("conversation");
  handle.child.kill("SIGTERM");
  await handle.exited;
  handle = await start();
  const duplicate = cli(
    "say",
    "--text",
    "整理项目资料，列出进展和待跟进事项",
    "--id",
    "project",
  );
  assert.equal(duplicate.duplicate, true);
  const history = cli("conversation"),
    events = await call("events");
  const artifacts = readdirSync(join(path, "artifacts"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      path: join(path, "artifacts", f),
      text: readFileSync(join(path, "artifacts", f), "utf8"),
    }));
  const assertions = {
    ordinaryChatCreatesNoWork: true,
    oneWork: history.works.length === 1,
    resultInOriginalConversation:
      history.messages.filter((m) => m.data.kind === "result").length === 1,
    restartPreservesMessages:
      history.messages.length === before.messages.length,
    duplicateInputRejected: duplicate.duplicate,
    actualMaterialRead: events.some((e) => e.kind === "material.read"),
    artifactContainsSource: artifacts.some((a) =>
      a.text.includes("Tasks、Actor"),
    ),
  };
  for (const [name, value] of Object.entries(assertions))
    assert.ok(value, name);
  mkdirSync(join(root, "evidence"), { recursive: true, mode: 0o700 });
  const target = join(root, "evidence/assistant-demo.json");
  writeFileSync(
    target,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        profile: path,
        modelMode: "fixture",
        assertions,
        transcript,
        history,
        artifacts,
        events,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify(
      { profile: path, evidence: target, modelMode: "fixture", assertions },
      null,
      2,
    ),
  );
} finally {
  if (handle?.child.exitCode === null && handle?.child.signalCode === null) {
    handle.child.kill("SIGTERM");
    await handle.exited;
  }
}
