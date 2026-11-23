// Explicit opt-in paid acceptance probe, not a benchmark or a quality score.
// The real main model chooses every proposal; no injected planner or forced retry.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { mkdir, mkdtemp, writeFile, cp, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readCodexConfiguration } from "./longmemeval.mjs";
import { initProfile, loadProfile } from "../src/profile.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { request } from "../src/runner.mjs";

const { values } = parseArgs({
  options: {
    "codex-config": { type: "string" },
    output: { type: "string" },
  },
});
if (!values["codex-config"] || !values.output)
  throw new Error("Required: --codex-config PRIVATE_JSON --output NEW_DIRECTORY");
const selected = await readCodexConfiguration(values["codex-config"]);
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const directory = await mkdtemp(join(tmpdir(), "sa-coord-"));
const profile = initProfile(directory, "isolated-butler-coordination-probe", {
  mode: "model",
  concurrency: 2,
  harnesses: { assistant: "codex", execution: "codex", codex: selected.codex },
  memoryPolicy: { enabled: false },
  runPolicy: { modelTimeoutMs: 60000, workTimeoutMs: 180000, maxSteps: 12 },
});
const report = {
  startedAt: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  sourceDirty: !!execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim(),
  assistantHarness: "codex",
  executionHarness: "codex",
  modelId: selected.codex.modelId,
  endpoint: selected.codex.baseUrl,
  reasoningEffort: selected.codex.reasoningEffort ?? "provider-default",
  memoryLearningEnabled: false,
  modelIsSynthetic: false,
  benchmarkScore: null,
  profileDirectory: directory,
  stage: "startup",
  checkpoints: [],
  turns: [],
};
const call = (op, params = {}, id = crypto.randomUUID()) => request(profile, { op, params, id });
const save = () => writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
async function checkpoint(stage, data = {}) {
  report.stage = stage;
  report.checkpoints.push({ stage, at: new Date().toISOString(), ...data });
  await save();
  console.log(JSON.stringify({ stage }));
}
async function waitFor(check) {
  const end = Date.now() + 180000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Deadline exceeded at ${report.stage}`);
    await delay(150);
  }
}
async function say(id, text, workId, expectedRevision) {
  await call("say", { text, ...(workId ? { workId, expectedRevision } : {}) }, id);
  const turn = await waitFor(async () => {
    const t = await call("turn", { inputId: id });
    if (t.status === "blocked") {
      report.turns.push(t);
      throw new Error(`Reception blocked: ${t.error ?? t.reply_text}`);
    }
    return t.status === "settled" && t;
  });
  report.turns.push(turn);
  await save();
  return turn;
}
async function workAt(id, status) {
  return waitFor(async () => {
    const d = await call("work", { workId: id });
    if (["blocked", "cancelled"].includes(d.work.status))
      throw new Error(`Work ${id} stopped: ${d.work.status}: ${d.work.error}`);
    return d.work.status === status && d;
  });
}
let runner;
try {
  runner = await LocalRunner.open(profile);
  await checkpoint("create-two-independent-works");
  const turn = await say(
    "two-works",
    `请创建两项独立后台笔记工作，用一次 batch 各 delegate 一项，主助理不要自己执行或询问。
A 工作名称 COORD-A：先且仅调用 ask_user 询问“请选择报告的时间范围”，等待我的真实回答；回答后用 publish_note 发布很短的 Markdown，必须包含 COORD-A 和我选择的范围。没有回答不能猜范围。
B 工作名称 COORD-B：立即调用 publish_note 发布一份很短的 Markdown，内容为“COORD-B 独立工作已完成”。不需要提问、不需要其他资料。
两项工作都只用上述本地工具，发布后向父助理报告完成。当前已明确授权创建这两个后台工作，不需要额外确认。`,
  );
  const decision = JSON.parse(turn.decision_json);
  assert.equal(decision.kind, "batch", "Real main model must create two independent works");
  assert.equal(decision.workIds?.length, 2);
  const details = await Promise.all(decision.workIds.map((workId) => call("work", { workId })));
  const a = details.find((d) => d.work.text.includes("COORD-A"));
  const b = details.find((d) => d.work.text.includes("COORD-B") && d !== a);
  assert.ok(a && b, "The two work goals must remain distinct");
  report.workIds = { A: a.work.id, B: b.work.id };
  await checkpoint("wait-A-while-B-completes");
  const [waiting, finished] = await Promise.all([workAt(a.work.id, "waiting_input"), workAt(b.work.id, "completed")]);
  assert.equal(waiting.interactions.length, 1);
  assert.equal(finished.results.length, 1);
  assert.ok(waiting.executions[0].conversation_id);
  report.overviewBeforeRestart = await call("work.overview");
  assert.equal(report.overviewBeforeRestart.total, 2);
  assert.equal(report.overviewBeforeRestart.byStatus.waiting_input, 1);
  assert.equal(report.overviewBeforeRestart.byStatus.completed, 1);
  await checkpoint("restart-while-A-waits");
  await runner.close();
  runner = undefined;
  runner = await LocalRunner.open(loadProfile(directory));
  report.overviewAfterRestart = await call("work.overview");
  assert.deepEqual(report.overviewAfterRestart.byStatus, report.overviewBeforeRestart.byStatus);
  await checkpoint("targeted-answer-through-real-main");
  const answered = await say(
    "answer-A",
    "时间范围选本周。请回答这个工作的待答问题，让它继续；不新建工作，不修改目标。",
    a.work.id,
    1,
  );
  assert.equal(JSON.parse(answered.decision_json).kind, "answer");
  const doneA = await workAt(a.work.id, "completed");
  assert.equal(doneA.executions.length, 1);
  assert.equal(doneA.executions[0].conversation_id, waiting.executions[0].conversation_id);
  assert.equal(doneA.interactions.length, 1);
  assert.equal(doneA.interactions[0].state, "answered");
  assert.equal(doneA.results.length, 1);
  report.sameNativeThreadAfterAnswer = true;
  await checkpoint("targeted-amend-keeps-work-identity");
  const amended = await say(
    "amend-B",
    "修改这个已完成工作的完整目标为：立即调用 publish_note 发布一份很短的 Markdown，正文写 COORD-B2 更新后的独立笔记。不要提问，不需要资料。保留本地笔记的完成要求。只修改原工作，不新建工作。",
    b.work.id,
    1,
  );
  assert.equal(JSON.parse(amended.decision_json).kind, "amend");
  const doneB = await workAt(b.work.id, "completed");
  assert.equal(doneB.work.revision, 2);
  assert.equal(doneB.executions.length, 2);
  assert.notEqual(doneB.executions[0].conversation_id, doneB.executions[1].conversation_id);
  assert.equal((await call("work", { workId: a.work.id })).work.revision, 1);
  report.newNativeThreadAfterGoalRevision = true;
  await checkpoint("status-through-real-main");
  const status = await say(
    "status",
    "请简短汇总当前这两项工作的真实状态和是否还需要我回答。只汇总，不创建或修改工作。不要把本地投递说成我已经阅读。请列出每项名称及状态。",
  );
  assert.ok(["reply", "send"].includes(JSON.parse(status.decision_json).kind));
  report.statusReply = status.reply_text;
  report.finalOverview = await call("work.overview");
  assert.equal(report.finalOverview.total, 2);
  assert.equal(report.finalOverview.byStatus.completed, 2);
  assert.equal(report.finalOverview.open, 0);
  report.artifacts = await Promise.all(
    (await readdir(join(directory, "artifacts")))
      .filter((n) => n.endsWith(".md"))
      .map(async (name) => ({
        name,
        text: await readFile(join(directory, "artifacts", name), "utf8"),
      })),
  );
  assert.equal(report.artifacts.length, 3);
  assert.ok(report.artifacts.some((a) => /COORD-A/.test(a.text) && /本周/.test(a.text)));
  assert.ok(report.artifacts.some((a) => /COORD-B2/.test(a.text)));
  report.passed = true;
  await checkpoint("passed");
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    if (runner) {
      report.events = await call("events").catch(() => []);
      report.usage = await call("usage").catch(() => null);
      report.conversation = await call("conversation").catch(() => null);
      report.finalState = await call("status").catch(() => null);
    }
  } finally {
    await runner?.close();
    await cp(directory, join(output, "profile"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    report.profileRetained = true;
    report.finishedAt = new Date().toISOString();
    await save();
  }
}
console.log(
  JSON.stringify({
    passed: report.passed,
    report: join(output, "report.json"),
    benchmarkScore: null,
  }),
);
