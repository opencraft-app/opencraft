import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { selectCases, benchmarkTime } from "./longmemeval-data.mjs";
import { runCase } from "./longmemeval.mjs";
const fixture = JSON.parse(
  await readFile(new URL("./smoke-data.json", import.meta.url), "utf8"),
);
const exec = promisify(execFile);

test("worker receives only question/date/roles/content, never answers, labels or dataset IDs", () => {
  const [item] = selectCases(fixture, 1);
  const serialized = JSON.stringify(item.input);
  for (const label of [
    "EVALUATOR_ONLY_GOLD_SENTINEL",
    "has_answer",
    "answer_session_ids",
    "question_type",
    "synthetic-memory-smoke",
  ])
    assert.equal(serialized.includes(label), false, label);
  assert.deepEqual(
    item.input.history[0].messages.map((row) => row.role),
    ["user", "assistant"],
  );
});

test("replay sorts by original date and preserves assistant evidence instead of converting it to user facts", () => {
  const row = structuredClone(fixture[0]);
  row.haystack_sessions.reverse();
  row.haystack_dates.reverse();
  row.haystack_session_ids.reverse();
  const [item] = selectCases([row], 1);
  assert.equal(
    item.input.history[0].messages[0].content,
    fixture[0].haystack_sessions[0][0].content,
  );
  assert.equal(item.input.history[0].messages[1].role, "assistant");
  assert.equal(
    benchmarkTime("2024/01/03 (Wed) 10:00"),
    Date.parse("2024-01-03T10:00Z"),
  );
  assert.throws(() => benchmarkTime("2024-01-03 10:00"), /timezone/);
});

test("future histories, duplicate identities, missing dates and malformed roles fail before model calls", () => {
  const row = structuredClone(fixture[0]);
  row.haystack_dates[0] = "2025-01-01T00:00Z";
  assert.throws(() => selectCases([row], 1, { strictTime: true }), /future/);
  assert.equal(
    selectCases([row], 1)[0].futureSessionCount,
    1,
    "official inputs are preserved, not silently filtered",
  );
  assert.throws(() => selectCases([...fixture, ...fixture], 1), /duplicate/);
  row.haystack_dates = [];
  assert.throws(() => selectCases([row], 1), /align/);
  const bad = structuredClone(fixture);
  bad[0].haystack_sessions[0][0].role = "system";
  assert.throws(() => selectCases(bad, 1), /message/);
});

test("official repeated session IDs preserve every positional transcript and remain evaluator-only", () => {
  const row = structuredClone(fixture[0]);
  row.haystack_session_ids[1] = row.haystack_session_ids[0];
  const [item] = selectCases([row], 1);
  assert.equal(item.repeatedSessionIds, 1);
  assert.equal(item.input.history.length, row.haystack_sessions.length);
  assert.deepEqual(
    item.input.history.map((s) => s.messages),
    row.haystack_sessions.map((s) =>
      s.map((m) => ({ role: m.role, content: m.content })),
    ),
  );
  assert.equal(
    JSON.stringify(item.input).includes(row.haystack_session_ids[0]),
    false,
  );
  row.haystack_session_ids[0] = null;
  assert.throws(() => selectCases([row], 1), /align/);
});

test("actual isolated assistant learns through native memory, retains all history and does not receive gold", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-eval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [item] = selectCases(fixture, 1);
  const first = await runCase(item.input, {
    directory: join(root, "first"),
    mode: "fixture",
    timeoutMs: 30000,
  });
  assert.equal(first.evidence.memoryFacts, 1);
  assert.equal(first.evidence.messages, 4);
  assert.equal(first.evidence.accuracy, null);
  assert.equal(first.evidence.learningStates.committed, 1);
  const clean = structuredClone(item.input);
  clean.history = [
    {
      at: clean.history[0].at,
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好" },
      ],
    },
  ];
  const second = await runCase(clean, {
    directory: join(root, "second"),
    mode: "fixture",
    timeoutMs: 30000,
  });
  assert.equal(
    second.evidence.memoryFacts,
    0,
    "a different case cannot see first-case memory",
  );
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else
        assert.equal(
          (await readFile(path)).includes(
            Buffer.from("EVALUATOR_ONLY_GOLD_SENTINEL"),
          ),
          false,
          path,
        );
    }
  }
  await scan(root);
});

test("long histories use original summary and bounded native history queries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-eval-long-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [item] = selectCases(fixture, 1);
  item.input.history = Array.from({ length: 16 }, (_, i) => ({
    at: item.input.history[0].at + i * 60000,
    messages: [
      {
        role: "user",
        content: `请记住上下文中的事项 ${i}：今天只是讨论，没有授权执行任何操作。`,
      },
      { role: "assistant", content: `这是历史回复 ${i}，不是实际完成回执。` },
    ],
  }));
  const result = await runCase(item.input, {
    directory: join(root, "profile"),
    mode: "fixture",
    timeoutMs: 30000,
  });
  assert.equal(result.evidence.messages, 32);
  assert.ok(
    result.evidence.workingContext,
    "real working context is exposed for coverage inspection",
  );
  assert.ok(
    result.evidence.workingContext.revision > 0 ||
      result.evidence.workingContext.summary,
    "native summary advanced",
  );
});

test("CLI retains failed cases and exports official hypothesis format without inventing scores", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-eval-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "run");
  const { writeFile } = await import("node:fs/promises");
  const rows = structuredClone(fixture);
  rows.push({
    ...structuredClone(fixture[0]),
    question_id: "failure",
    question: "每隔5秒提醒我：核对状态",
  });
  const path = join(root, "dataset.json");
  await writeFile(path, JSON.stringify(rows));
  await assert.rejects(
    exec(
      process.execPath,
      [
        "evaluation/longmemeval.mjs",
        "--dataset",
        path,
        "--output",
        output,
        "--mode",
        "fixture",
        "--limit",
        "2",
      ],
      { cwd: new URL("..", import.meta.url), timeout: 60000 },
    ),
  );
  const summary = JSON.parse(
    await readFile(join(output, "summary.json"), "utf8"),
  );
  const hypotheses = (await readFile(join(output, "hypotheses.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.accuracy, null);
  assert.equal(hypotheses.length, 2);
  assert.equal(hypotheses[1].hypothesis, "");
  assert.deepEqual(Object.keys(hypotheses[0]).sort(), [
    "hypothesis",
    "question_id",
  ]);
});

test("real mode refuses implicit machine credentials before creating output or making requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-eval-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "not-created");
  await assert.rejects(
    exec(
      process.execPath,
      [
        "evaluation/longmemeval.mjs",
        "--dataset",
        "evaluation/smoke-data.json",
        "--output",
        output,
        "--mode",
        "model",
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, ANTHROPIC_API_KEY: "unused-machine-secret" },
        timeout: 10000,
      },
    ),
    /explicit private/,
  );
  assert.deepEqual(await readdir(root), []);
});
