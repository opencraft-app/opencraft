import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  parseContexts,
  validateQuestions,
  selectQuestions,
  projectGroup,
  scoreOption,
} from "./personamem-data.mjs";
import { readerInput, readMemoryQuestion } from "./memory-system-session.mjs";
import { summarizeMemoryRun, summarizeCalls } from "./memory-system.mjs";

const row = (extra = {}) => ({
  question_id: "q",
  persona_id: "p",
  shared_context_id: "ctx",
  question_type: "recall_user_shared_facts",
  user_question_or_message: "Which?",
  all_options: "(a) old\n(b) new\n(c) third\n(d) fourth",
  correct_answer: "(b)",
  end_index_in_shared_context: "3",
  ...extra,
});
const messages = [
  { role: "system", content: "Known persona" },
  { role: "user", content: "I prefer tea" },
  { role: "assistant", content: "Perhaps coffee?" },
  { role: "user", content: "Future secret" },
];

test("CSV preserves quoted newlines, commas, quotes, empty fields, CRLF and EOF", () => {
  assert.deepEqual(parseCsv('id,text,empty\r\n1,"a,b\r\nc ""d""",\r\n2,end,'), [
    { id: "1", text: 'a,b\r\nc "d"', empty: "" },
    { id: "2", text: "end", empty: "" },
  ]);
  assert.throws(() => parseCsv('a,b\n"unterminated'), /Unterminated/);
  assert.throws(() => parseCsv('a,b\n"x"z,y'), /quoting/);
  assert.throws(() => parseCsv("a,b\n1"), /count/);
});
test("reject malformed context, duplicate identities, cross-persona reuse and future boundary", () => {
  const contexts = new Map([["ctx", messages]]);
  assert.throws(
    () => parseContexts('{"ctx":[{"role":"tool","content":"x"}]}'),
    /Unsupported/,
  );
  assert.throws(() => parseContexts('{"ctx":[]}'), /Invalid/);
  assert.throws(() => validateQuestions([row(), row()], contexts), /Duplicate/);
  assert.throws(
    () =>
      validateQuestions(
        [row(), row({ question_id: "q2", persona_id: "other" })],
        contexts,
      ),
    /personas/,
  );
  assert.throws(
    () =>
      validateQuestions([row({ end_index_in_shared_context: "5" })], contexts),
    /boundary/,
  );
});
test("selection is invariant to gold and length; projection hides annotations and future text", () => {
  const contexts = new Map([["ctx", messages]]);
  const rows = [row(), row({ question_id: "q2" })];
  const g = selectQuestions(rows, 1, "seed")[0];
  const changed = selectQuestions(
    rows.map((r) => ({
      ...r,
      correct_answer: "(d)",
      context_length_in_tokens: "1",
    })),
    1,
    "seed",
  )[0];
  assert.deepEqual(
    g.questions.map((r) => r.question_id),
    changed.questions.map((r) => r.question_id),
  );
  const projected = projectGroup(g, contexts);
  assert.deepEqual(projected.history, messages.slice(0, 3));
  assert.deepEqual(Object.keys(projected), ["history", "queries"]);
  assert.deepEqual(Object.keys(projected.queries[0]), [
    "end",
    "question",
    "options",
  ]);
  for (const forbidden of [
    "correct_answer",
    "question_id",
    "question_type",
    "persona_id",
    "Future secret",
  ])
    assert.ok(!JSON.stringify(projected).includes(forbidden));
});
test("same reader receives mutually isolated memory/history and common causal persona", () => {
  const q = { question: "Q", options: "A" },
    seed = {
      memoryContext: { profile: [{ content: "new tea" }] },
      memoryRecall: ["memory"],
    };
  const m = readerInput(messages.slice(0, 3), q, "memory", seed);
  const h = readerInput(messages.slice(0, 3), q, "full-history", seed);
  const n = readerInput(messages.slice(0, 3), q, "no-history", seed);
  assert.deepEqual(m.history, []);
  assert.deepEqual(n.history, []);
  assert.deepEqual(h.history, messages.slice(1, 3));
  assert.deepEqual(h.memoryContext, null);
  assert.deepEqual(n.memoryContext, null);
  assert.deepEqual(m.background, h.background);
  assert.deepEqual(m.background, n.background);
  assert.ok(!JSON.stringify(m).includes("Perhaps coffee?"));
  assert.ok(!JSON.stringify(n).includes("new tea"));
});
test("reader cannot escape into history/actions and does not fabricate answers on exhausted rounds", async () => {
  let calls = 0;
  const session = {
    trace: [],
    execute: () => {
      calls++;
      return { ok: true };
    },
  };
  await assert.rejects(
    readMemoryQuestion(
      { availableQueries: ["memory.get"] },
      {
        session,
        signal: new AbortController().signal,
        decide: async () => ({
          kind: "query",
          name: "history.search",
          params: { query: "tea" },
        }),
      },
    ),
    /unavailable/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    readMemoryQuestion(
      { availableQueries: [] },
      {
        session,
        signal: new AbortController().signal,
        decide: async () => ({ kind: "remember", value: "fake" }),
      },
    ),
    /unavailable/,
  );
  await assert.rejects(
    readMemoryQuestion(
      { availableQueries: ["memory.get"] },
      {
        session,
        signal: new AbortController().signal,
        decide: async () => ({
          kind: "query",
          name: "memory.get",
          params: { key: "x" },
        }),
      },
    ),
    /budget/,
  );
  assert.equal(calls, 7);
});
test("reader actually incorporates host observation; one result does not become a new learning turn", async () => {
  const seen = [],
    session = {
      trace: ["host"],
      execute: (q) => ({ query: q, response: { data: "new tea" } }),
    };
  const answer = await readMemoryQuestion(
    { availableQueries: ["memory.get"] },
    {
      session,
      signal: new AbortController().signal,
      decide: async (i) => {
        seen.push(i);
        return i.observations.length
          ? { kind: "reply", text: "<final_answer>(b)" }
          : { kind: "query", name: "memory.get", params: { key: "drink" } };
      },
    },
  );
  assert.equal(seen[1].observations[0].response.data, "new tea");
  assert.equal(answer.rounds, 2);
  assert.deepEqual(answer.queries, ["host"]);
});
test("official option scoring preserves marker and full-response fallback behavior", () => {
  assert.equal(
    scoreOption("consider (a), then <final_answer>(b)</final_answer>", "(b)"),
    true,
  );
  assert.equal(scoreOption("(a) or (b)", "b"), false);
  assert.equal(scoreOption("", "b"), false);
  assert.equal(scoreOption("B", "(b)"), true);
  assert.equal(scoreOption("<final_answer> unsure (d)", "(b)"), false);
});
test("failed and missing answers stay in denominator, unknown cost stays unknown", () => {
  const plan = {
    groups: [{ persona: "p", questions: [row(), row({ question_id: "q2" })] }],
    protocol: { limitations: [] },
  };
  const result = summarizeMemoryRun(plan, [
    {
      group: 0,
      status: "failed",
      progress: [
        {
          type: "answer",
          query: 0,
          arm: "memory",
          status: "completed",
          hypothesis: "(b)",
          callIds: [],
          elapsedMs: 1,
        },
        {
          type: "answer",
          query: 1,
          arm: "memory",
          status: "failed",
          hypothesis: "",
          callIds: [],
          elapsedMs: 2,
        },
      ],
    },
  ]);
  assert.equal(result.arms.memory.accuracy, 0.5);
  assert.equal(result.arms["full-history"].accuracy, null);
  assert.equal(result.arms["full-history"].pending, 2);
  assert.equal(result.billedCost, null);
  assert.equal(
    summarizeCalls([{ outcome: "error", elapsedMs: 1 }]).knownTokens,
    null,
  );
  assert.equal(
    summarizeCalls([{ outcome: "error", elapsedMs: 1 }]).callsWithUnknownTokens,
    1,
  );
});

test("native default policy merges twelve real exchanges, verifies and persists original user evidence", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { initProfile } = await import("../src/adapters/local/profile.mjs");
  const { createLocalDomain } = await import(
    "../src/runtime/create-local-domain.mjs"
  );
  const { MemoryLearningModel } = await import(
    "../src/adapters/models/memory-learning-model.mjs"
  );
  const { MemoryLearningCoordinator } = await import(
    "../src/runtime/memory-learning-coordinator.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "sa-memory-eval-test-"));
  let clock = Date.parse("2026-11-09T00:00:00Z");
  const profile = initProfile(root, "synthetic", { mode: "fixture" });
  const { app, uow } = createLocalDomain(profile, null, { now: () => clock });
  const learning = new MemoryLearningCoordinator(
    app.memoryLearning,
    new MemoryLearningModel({ configured: { mode: "fixture" } }),
  );
  try {
    for (let i = 0; i < 12; i++) {
      const turn = {
        id: `recorded:${i}`,
        conversation_id: app.history.main.id,
        text: `我喜欢简短回答 ${i}`,
        created_at: clock,
        query_scope_json: JSON.stringify(
          app.scope.queryGrant(`recorded:${i}`, app.history.main.id),
        ),
      };
      app.uow.transaction(() =>
        app.memoryLearning.capture(turn, "Perhaps a long response?"),
      );
      clock += 100;
    }
    assert.equal(profile.config.memoryPolicy.debounceMs, 15000);
    assert.equal(app.memoryLearning.pending().length, 0);
    clock += 15000;
    const [job] = app.memoryLearning.pending();
    assert.equal(job.batchIds.length, 12);
    assert.equal(job.evidence.length, 24);
    assert.equal(job.evidence.filter((e) => e.role === "user").length, 12);
    await learning.process(job, new AbortController().signal);
    assert.equal(app.memoryLearning.get(job.id).state, "committed");
    assert.equal(app.memory.list().filter((m) => !m.deleted).length, 1);
    const states = Array.from(
      { length: 12 },
      (_, i) => app.memoryLearning.get(`learning:recorded:${i}`).state,
    );
    assert.equal(states.filter((s) => s === "merged").length, 11);
    const turn = {
      id: "query",
      conversation_id: app.history.main.id,
      query_scope_json: JSON.stringify(
        app.scope.queryGrant("query", app.history.main.id),
      ),
    };
    const observed = app.receptionQueries.open(turn).execute({
      kind: "query",
      name: "memory.file.read",
      params: { scope: "agent", path: "profile.md" },
    });
    assert.equal(observed.response.ok, true);
    assert.match(JSON.stringify(observed), /简短回答/);
    assert.match(await readFile(join(root, "profile.json"), "utf8"), /15000/);
  } finally {
    await learning.suspend();
    uow.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a shared deadline abort is censored, not scored as a wrong control answer", () => {
  const plan = {
    groups: [{ persona: "p", questions: [row()] }],
    protocol: { limitations: [] },
  };
  const result = summarizeMemoryRun(plan, [
    {
      group: 0,
      status: "failed",
      progress: [
        {
          type: "answer",
          query: 0,
          arm: "full-history",
          status: "failed",
          error: 23,
          hypothesis: "",
          callIds: [],
          elapsedMs: 1,
        },
      ],
    },
  ]);
  assert.equal(result.arms["full-history"].failed, 0);
  assert.equal(result.arms["full-history"].deadlineCensored, 1);
  assert.equal(result.arms["full-history"].accuracy, null);
  assert.equal(result.arms["full-history"].bounds.upper, 1);
});

test("control processes retain their own complete results when memory later times out", async () => {
  const { runMemoryGroupWithControls } = await import("./memory-system.mjs");
  const observed = [],
    progress = [];
  const result = await runMemoryGroupWithControls(
    { history: messages, queries: [] },
    {
      directory: "/tmp/independent-eval",
      timeoutMs: 900000,
      controlTimeoutMs: 300000,
      onRecord: (r) => progress.push(r),
    },
    async (input, options) => {
      observed.push({
        arms: input.arms,
        directory: options.directory,
        timeoutMs: options.timeoutMs,
      });
      if (input.arms.includes("memory")) {
        options.onRecord({
          type: "usage",
          call: { id: "failed-prepare", kind: "memory-propose" },
        });
        return { status: "failed", error: "deadline" };
      }
      const answers = input.arms.map((arm) => ({
        query: 0,
        arm,
        status: "completed",
        hypothesis: "(b)",
        callIds: [arm],
      }));
      for (const r of answers) options.onRecord({ type: "answer", ...r });
      return {
        status: "completed",
        result: {
          results: answers,
          calls: input.arms.map((arm) => ({ id: arm, kind: "reception" })),
        },
      };
    },
  );
  assert.deepEqual(observed, [
    {
      arms: ["full-history", "no-history"],
      directory: "/tmp/independent-eval/controls",
      timeoutMs: 300000,
    },
    {
      arms: ["memory"],
      directory: "/tmp/independent-eval/memory",
      timeoutMs: 900000,
    },
  ]);
  assert.equal(result.status, "failed");
  assert.equal(result.result.results.length, 2);
  assert.equal(result.result.calls.length, 3);
  assert.equal(progress.length, 3);
});

test("component memory reader exposes the same bounded retrieval contract as the product without granting history", () => {
  const m = readerInput(
    messages,
    { question: "Q", options: "A" },
    "memory",
    {},
  );
  assert.ok(m.availableQueries.includes("memory.files.list"));
  assert.match(
    m.queryContracts["memory.search"].description,
    /every whitespace-separated term/,
  );
  assert.equal(
    m.queryContracts["memory.search"].parameters.limit,
    "1..12 (default 12)",
  );
  assert.equal(m.availableQueries.includes("history.read"), false);
  const n = readerInput(
    messages,
    { question: "Q", options: "A" },
    "no-history",
    {},
  );
  assert.deepEqual(n.queryContracts, {});
});
