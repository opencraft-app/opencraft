import { parseArgs } from "node:util";
import { mkdir, writeFile, mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  readModelConfiguration,
  readCodexConfiguration,
} from "./longmemeval.mjs";
import { initProfile, loadProfile } from "../src/adapters/local/profile.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { request } from "../src/adapters/local/unix-socket.mjs";

const { values: v } = parseArgs({
  options: {
    "model-config": { type: "string" },
    "codex-config": { type: "string" },
    output: { type: "string" },
  },
});
if (!v["model-config"] === !v["codex-config"] || !v.output)
  throw new Error(
    "Expected exactly one --model-config or --codex-config and --output NEW_DIR",
  );
const harnesses = v["codex-config"]
  ? await readCodexConfiguration(v["codex-config"])
  : undefined;
if (harnesses) harnesses.execution = "codex";
const config = v["model-config"]
  ? await readModelConfiguration(v["model-config"])
  : harnesses.codex;
const variable = {
  deepseek: "DEEPSEEK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "openai-compatible": "OPENCRAFT_EVAL_API_KEY",
}[config.provider];
if (variable) process.env[variable] = config.apiKey;
const model = {
  provider: config.provider ?? "codex-responses",
  modelId: config.modelId,
  ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  ...(config.thinking ? { thinking: config.thinking } : {}),
};
const directory = resolve(v.output);
await mkdir(directory, { mode: 0o700 });
const profile = initProfile(
  await mkdtemp(join(tmpdir(), "sa-lifecycle-")),
  "synthetic-lifecycle-human",
  { mode: "model", ...(harnesses ? { harnesses } : { model }), concurrency: 1 },
);
const report = {
  schemaVersion: 1,
  model,
  assistantHarness: harnesses ? "codex" : "pi",
  profileDirectory: profile.path,
  steps: [],
  mechanisms: {},
  qualityScore: null,
  scope:
    "Natural user messages through original LocalRunner/UnixSocket/Reception; synthetic personal facts only; no official benchmark score",
};
let runner;
try {
  runner = await LocalRunner.open(profile);
  const messages = [
    "Please explicitly remember that my preferred test city is Kyoto.",
    "Please update my saved preferred test city to Sapporo, replacing Kyoto.",
    "Please forget my saved preferred test city. Remove that fact from active memory.",
    "What is my preferred test city?",
  ];
  for (let i = 0; i < messages.length; i++) {
    const id = "lifecycle-" + i,
      start = Date.now();
    await request(profile, { op: "say", id, params: { text: messages[i] } });
    let turn;
    while (Date.now() - start < 120000) {
      turn = await request(profile, {
        op: "turn",
        id: "read-" + id,
        params: { inputId: id },
      });
      if (["settled", "blocked"].includes(turn.status)) break;
      await delay(100);
    }
    if (!["settled", "blocked"].includes(turn?.status))
      throw new Error("Lifecycle turn timed out");
    const memories = await request(profile, {
      op: "memory.list",
      id: "memories-" + id,
      params: {},
    });
    const active = memories.filter((m) => !m.deleted);
    report.steps.push({
      input: messages[i],
      status: turn.status,
      response: turn.reply_text,
      decision: turn.decision_json ? JSON.parse(turn.decision_json) : null,
      memories,
      memoryCatalog: runner.app.memory.catalog(),
      elapsedMs: Date.now() - start,
    });
    if (i === 0)
      report.mechanisms.rememberStored = active.some((m) =>
        m.value?.includes("Kyoto"),
      );
    if (i === 1)
      report.mechanisms.correctionStored =
        active.some((m) => m.value?.includes("Sapporo")) &&
        !active.some((m) => m.value?.includes("Kyoto"));
    if (i === 2) {
      report.mechanisms.activeMemoryForgotten = !active.some((m) =>
        /Kyoto|Sapporo/.test(m.value ?? ""),
      );
      report.mechanisms.forgottenTombstonePreserved = memories.some(
        (m) => m.deleted,
      );
    }
    if (i === 3)
      report.mechanisms.forgottenValueMentionedInReply = /Sapporo|Kyoto/i.test(
        turn.reply_text ?? "",
      );
    if (turn.status === "blocked")
      throw new Error("Original assistant blocked the lifecycle turn");
    if (turn.work_id)
      throw new Error("Assistant delegated work instead of a memory operation");
    if (i === 2) {
      await runner.close();
      runner = await LocalRunner.open(loadProfile(profile.path));
      report.restartedAfterForget = true;
    }
    console.log(
      JSON.stringify({
        step: i + 1,
        status: turn.status,
        elapsedMs: Date.now() - start,
      }),
    );
  }
  report.usage = await request(profile, {
    op: "usage",
    id: "usage-report",
    params: { limit: 100 },
  });
  report.passed = [
    "rememberStored",
    "correctionStored",
    "activeMemoryForgotten",
    "forgottenTombstonePreserved",
  ].every((k) => report.mechanisms[k] === true);
  if (!report.passed) process.exitCode = 1;
  report.replyDisclosureContract =
    "observed-separately-history-retained-no-physical-erasure-claim";
} catch (error) {
  report.passed = false;
  report.error = String(error.message).split(config.apiKey).join("[redacted]");
  process.exitCode = 1;
} finally {
  try {
    await runner?.close();
  } catch (error) {
    report.closeError = String(error.message)
      .split(config.apiKey)
      .join("[redacted]");
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await cp(profile.path, join(directory, "profile"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      directory,
      mechanisms: report.mechanisms,
      passed: report.passed,
      error: report.error ?? null,
      qualityScore: null,
    }),
  );
}
