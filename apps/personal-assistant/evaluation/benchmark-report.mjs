import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { infrastructureFailure, recordVerdict } from "./benchmark-failures.mjs";

function distribution(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return {
    count: a.length,
    mean: a.reduce((x, y) => x + y, 0) / a.length,
    p50: a[Math.ceil(a.length * 0.5) - 1],
    p95: a[Math.ceil(a.length * 0.95) - 1],
  };
}

export function scoreRecords(records, expected) {
  const correct = records.filter((r) => recordVerdict(r) === true).length;
  const infra = records.filter(infrastructureFailure).length;
  const failed = records.filter(
    (r) => r.status !== "completed" && !infrastructureFailure(r),
  ).length;
  const unresolved = records.filter((r) => recordVerdict(r) === null).length;
  const judgeFailures = records.filter(
    (r) => r.status === "completed" && recordVerdict(r) === null,
  ).length;
  const available = records.filter((r) => !infrastructureFailure(r));
  const nativeTotals = records.flatMap(
    (r) => r.evidence?.usage?.totalsByMode ?? [],
  );
  return {
    expected,
    finished: records.length,
    pending: expected - records.length,
    correct,
    answersCompleted: records.filter((r) => r.status === "completed").length,
    infrastructureFailures: infra,
    answerFailures: failed,
    judgeFailures,
    unresolved,
    accuracy:
      records.length === expected && unresolved === 0
        ? correct / expected
        : null,
    conservativeLowerBound: correct / expected,
    upperBound: (correct + unresolved + expected - records.length) / expected,
    wilson95:
      records.length === expected && unresolved === 0
        ? wilson(correct, expected)
        : null,
    latencyMs: distribution(available.map((r) => r.answerElapsedMs)),
    allObservedLatencyMs: distribution(records.map((r) => r.answerElapsedMs)),
    answerFailureRate: records.length ? failed / records.length : null,
    answerCompletionRate: expected
      ? records.filter((r) => r.status === "completed").length / expected
      : null,
    indexingMs: distribution(records.map((r) => r.evidence?.indexingMs)),
    queryMs: distribution(records.map((r) => r.evidence?.queryMs)),
    knownAnswerTokens: nativeTotals.length
      ? nativeTotals.reduce((n, t) => n + (t.knownTotals.totalTokens ?? 0), 0)
      : records.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0),
    knownNativeHostObservations: nativeTotals.reduce(
      (n, t) => n + t.observations,
      0,
    ),
    knownJudgeTokens: records.reduce(
      (n, r) => n + (r.judge?.usage?.total_tokens ?? 0),
      0,
    ),
    costUsd: null,
  };
}

function wilson(k, n) {
  const z = 1.959963984540054,
    p = k / n,
    d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d,
    half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return {
    low: Math.max(0, mid - half),
    high: Math.min(1, mid + half),
    note: "Descriptive binomial interval; stratified subset and same-model judging limit inference.",
  };
}

async function main() {
  if (!process.argv[2]) throw new Error("Expected benchmark output directory");
  const directory = resolve(process.argv[2]);
  const plan = JSON.parse(await readFile(join(directory, "plan.json"), "utf8"));
  const records = [];
  for (const name of await readdir(join(directory, "records"))) {
    if (!name.endsWith(".json")) continue;
    try {
      records.push(
        JSON.parse(await readFile(join(directory, "records", name), "utf8")),
      );
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  const report = {
    benchmark: `LongMemEval-${plan.variant ?? "oracle"}-stratified-subset`,
    generatedAt: new Date().toISOString(),
    model: plan.identity.model,
    officialLeaderboardScore: false,
    judge: "same-model/official-rubric-port",
    sourceSha256: plan.identity.sourceSha256,
    sourceCodeSha256: plan.identity.sourceCodeSha256,
    seed: plan.identity.seed,
    tracks: {},
    limitations: [
      (plan.variant ?? "oracle") === "oracle"
        ? "Oracle evidence sessions only, not LongMemEval-S/M full histories."
        : `Classic LongMemEval-${plan.variant.toUpperCase()} full histories under recorded per-exchange learning replay; not product online latency.`,
      "Fixed balanced subset, excluding the four previous pilot cases; not the 500-question full benchmark.",
      "Same model grades both tracks; self-judging bias remains.",
      "Native assistant and full-history baseline use different architectures/prompts; baseline includes original message dates.",
      "Product answer failures count as wrong; transport/availability and judge failures remain unresolved, not dropped.",
      "Timeouts are censored observations; report failure rate together with latency. Unstarted gated cases remain pending, not incorrect.",
    ],
  };
  for (const track of ["native-assistant", "full-history-baseline"]) {
    const group = records.filter((r) => r.track === track);
    const byStratum = {},
      byOfficialCategory = {};
    for (const s of [...new Set(plan.selected.map((r) => r.stratum))].sort())
      byStratum[s] = scoreRecords(
        group.filter((r) => r.stratum === s),
        plan.selected.filter((r) => r.stratum === s).length,
      );
    for (const c of [...new Set(plan.selected.map((r) => r.type))].sort())
      byOfficialCategory[c] = scoreRecords(
        group.filter((r) => r.category === c),
        plan.selected.filter((r) => r.type === c).length,
      );
    report.tracks[track] = {
      ...scoreRecords(group, plan.selected.length),
      byStratum,
      byOfficialCategory,
    };
  }
  const pairs = plan.selected.map((item) => {
    const native = records.find(
        (r) =>
          r.question_id === item.question_id && r.track === "native-assistant",
      ),
      baseline = records.find(
        (r) =>
          r.question_id === item.question_id &&
          r.track === "full-history-baseline",
      );
    return {
      question_id: item.question_id,
      native: recordVerdict(native),
      baseline: recordVerdict(baseline),
    };
  });
  report.paired = {
    bothCorrect: pairs.filter((p) => p.native === true && p.baseline === true)
      .length,
    nativeOnly: pairs.filter((p) => p.native === true && p.baseline === false)
      .length,
    baselineOnly: pairs.filter((p) => p.native === false && p.baseline === true)
      .length,
    bothIncorrect: pairs.filter(
      (p) => p.native === false && p.baseline === false,
    ).length,
  };
  await writeFile(
    join(directory, "score.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      {
        directory,
        tracks: Object.fromEntries(
          Object.entries(report.tracks).map(([k, v]) => [
            k,
            {
              finished: v.finished,
              expected: v.expected,
              correct: v.correct,
              accuracy: v.accuracy,
              infrastructureFailures: v.infrastructureFailures,
              answerFailures: v.answerFailures,
              judgeFailures: v.judgeFailures,
            },
          ]),
        ),
        paired: report.paired,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
