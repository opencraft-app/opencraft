// Explicit opt-in real model smoke; synthetic work only, no external delivery.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import {
  mkdir,
  writeFile,
  readdir,
  readFile,
  mkdtemp,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readCodexConfiguration } from "./longmemeval.mjs";
import { initProfile, loadProfile } from "../src/adapters/local/profile.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { request } from "../src/adapters/local/unix-socket.mjs";

const { values } = parseArgs({
  options: {
    "codex-config": { type: "string" },
    output: { type: "string" },
    "all-codex": { type: "boolean", default: false },
  },
});
if (!values["codex-config"] || !values.output)
  throw new Error(
    "Required: --codex-config PRIVATE_JSON --output NEW_DIRECTORY",
  );
const selected = await readCodexConfiguration(values["codex-config"]);
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const directory = await mkdtemp(join(tmpdir(), "sa-codex-exec-"));
const profile = initProfile(directory, "isolated-native-execution-probe", {
  mode: values["all-codex"] ? "model" : "fixture",
  harnesses: {
    assistant: values["all-codex"] ? "codex" : "pi",
    execution: "codex",
    codex: selected.codex,
  },
  memoryPolicy: { enabled: false },
  runPolicy: { modelTimeoutMs: 60000, workTimeoutMs: 180000, maxSteps: 12 },
});
const report = {
  startedAt: new Date().toISOString(),
  assistantHarness: values["all-codex"] ? "codex" : "pi-fixture",
  executionHarness: "codex",
  endpoint: selected.codex.baseUrl,
  modelId: selected.codex.modelId,
  modelIsSynthetic: false,
  benchmarkScore: null,
  profileDirectory: directory,
};
const call = (op, params = {}, id = crypto.randomUUID()) =>
  request(profile, { op, params, id });
async function waitFor(workId, predicate) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const detail = await call("work", { workId });
    if (predicate(detail)) return detail;
    if (["blocked", "failed", "cancelled"].includes(detail.work.status))
      throw new Error("Native smoke work stopped: " + detail.work.status);
    await delay(100);
  }
  throw new Error("Native execution smoke deadline exceeded");
}
let runner;
try {
  runner = await LocalRunner.open(profile);
  const receipt = await call(
    values["all-codex"] ? "say" : "submit",
    {
      text: "请立即创建并委托一个后台笔记工作，不要由主助理直接提问或回答。后台工作的完整要求如下：先且仅调用 ask_user 问我要哪一个时间范围，必须等待我的实际回答。收到回答之后调用 publish_note 发布一份很短的 Markdown，正文明确写出我选择的范围；随后向父助理报告完成。不能猜测范围，不要调用其他工具，也不要发送外部消息。这是合成持久执行烟测，当前无需资料或其他信息即可创建工作，时间范围由后台工作自行 ask_user 获取。",
    },
    "native-execution-smoke",
  );
  let workId = receipt.workId;
  if (values["all-codex"]) {
    const deadline = Date.now() + 180000;
    let inputId = "native-execution-smoke";
    report.receptionTurns = [];
    for (;;) {
      const turn = await call("turn", { inputId });
      report.nativeReceptionTurn = turn;
      if (turn.status === "blocked")
        throw new Error("Native reception blocked");
      if (turn.status === "settled") {
        report.nativeReceptionTurn = turn;
        report.receptionTurns.push(turn);
        if (
          !turn.work_id &&
          JSON.parse(turn.decision_json).kind === "clarify" &&
          report.receptionTurns.length === 1
        ) {
          inputId = "native-execution-confirmation";
          await call(
            "say",
            {
              text: "是的，确认按上述要求创建后台笔记委托。时间范围尚未给出，由后台 ask_user 等待获取；现在即可创建工作，不需要主聊天再确认。",
            },
            inputId,
          );
          continue;
        }
        assert.ok(
          turn.work_id,
          "The real native assistant must delegate this task",
        );
        workId = turn.work_id;
        report.nativeReceptionDelegated = true;
        break;
      }
      if (Date.now() > deadline)
        throw new Error("Native reception deadline exceeded");
      await delay(100);
    }
  }
  const pending = await waitFor(
    workId,
    (d) => d.work.status === "waiting_input",
  );
  const original = pending.executions[0].conversation_id;
  assert.equal(pending.interactions.length, 1);
  await runner.close();
  runner = undefined;
  report.restartedWhileWaiting = true;
  runner = await LocalRunner.open(loadProfile(profile.path));
  const question = pending.interactions[0];
  await call(
    "interaction.answer",
    {
      interactionId: question.id,
      expectedRevision: question.revision,
      text: "week",
    },
    "native-smoke-answer",
  );
  const done = await waitFor(workId, (d) => d.work.status === "completed");
  assert.equal(done.executions[0].conversation_id, original);
  assert.equal(done.interactions.length, 1);
  assert.equal(done.interactions[0].state, "answered");
  assert.equal(done.results.length, 1);
  assert.equal(done.deliveries.length, 1);
  const artifacts = (await readdir(join(directory, "artifacts"))).filter(
    (name) => name.endsWith(".md"),
  );
  assert.equal(artifacts.length, 1);
  const note = await readFile(
    join(directory, "artifacts", artifacts[0]),
    "utf8",
  );
  assert.match(note, /week/i);
  report.note = note;
  report.artifactCount = artifacts.length;
  report.sameNativeThread = true;
  if (values["all-codex"]) {
    const history = await call("conversation");
    assert.ok(
      history.messages.some((m) => m.data?.kind === "result"),
      "Native parent must accept the execution report into the original conversation",
    );
    report.nativeParentDelivered = true;
  }
  report.interactionState = done.interactions[0].state;
  report.results = done.results.length;
  report.deliveries = done.deliveries.length;
  report.result = done.results[0];
  report.usage = await call("usage");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  if (runner) {
    report.events = await call("events").catch(() => []);
    report.usage = await call("usage").catch(() => null);
  }
  process.exitCode = 1;
} finally {
  try {
    await runner?.close();
  } finally {
    report.profileRetained = true;
    await cp(directory, join(output, "profile"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    report.finishedAt = new Date().toISOString();
    await writeFile(
      join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }
}
console.log(
  JSON.stringify({
    passed: report.passed,
    report: join(output, "report.json"),
    benchmarkScore: null,
  }),
);
