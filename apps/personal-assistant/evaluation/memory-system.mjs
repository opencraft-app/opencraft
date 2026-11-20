import { installationManifests } from "./installation-manifests.mjs";
import { parseArgs } from "node:util";
import { fork } from "node:child_process";
import {
  readFile,
  mkdir,
  writeFile,
  readdir,
  copyFile,
} from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readCodexConfiguration } from "./longmemeval.mjs";
import { SUPPORTED_CODEX_VERSION } from "../src/adapters/codex/native-session.mjs";
import { MEMORY_ARMS, READER_INSTRUCTION } from "./memory-system-session.mjs";
import {
  PERSONAMEM_TYPES,
  parseCsv,
  parseContexts,
  validateQuestions,
  selectQuestions,
  projectGroup,
  scoreOption,
  hash,
} from "./personamem-data.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export function summarizeMemoryRun(plan, records) {
  const all = records.flatMap((r) =>
    (r.result?.results ?? r.progress.filter((p) => p.type === "answer")).map(
      (a) => ({ ...a, group: r.group }),
    ),
  );
  const arms = Object.fromEntries(
    MEMORY_ARMS.map((arm) => {
      const rows = all.filter((r) => r.arm === arm),
        returned = rows.filter((r) => r.status === "completed");
      const correct = returned.filter((a) =>
        scoreOption(
          a.hypothesis,
          plan.groups[a.group].questions[a.query].correct_answer,
        ),
      ).length;
      const completedIds = new Set(rows.map((r) => `${r.group}:${r.query}`));
      if (completedIds.size !== rows.length)
        throw new Error("Duplicate question result");
      const planned = plan.groups.reduce((n, g) => n + g.questions.length, 0);
      const deadlineCensored = rows.filter(
        (r) =>
          r.status === "failed" &&
          (r.failureType === "group-deadline" || r.error === 23),
      ).length;
      const failed = rows.length - returned.length - deadlineCensored,
        pending = planned - rows.length;
      const calls = records.flatMap(
        (r) =>
          r.result?.calls ??
          r.progress.filter((p) => p.type === "usage").map((p) => p.call),
      );
      const callIds = new Set(rows.flatMap((r) => r.callIds));
      const usage = calls.filter((c) => callIds.has(c.id));
      return [
        arm,
        {
          planned,
          answered: returned.length,
          correct,
          incorrect: returned.length - correct,
          failed,
          pending,
          deadlineCensored,
          accuracy: pending || deadlineCensored ? null : correct / planned,
          bounds: {
            lower: correct / planned,
            upper: (correct + pending + deadlineCensored) / planned,
          },
          answerCompletionRate: returned.length / planned,
          queryUsage: summarizeCalls(usage),
          queryElapsedMs: rows.map((r) => r.elapsedMs),
        },
      ];
    }),
  );
  const prepCalls = records
    .flatMap(
      (r) =>
        r.result?.calls ??
        r.progress.filter((p) => p.type === "usage").map((p) => p.call),
    )
    .filter((c) => c.kind !== "reception");
  return {
    schemaVersion: 1,
    target: "grokbot-derived-memory-scheme",
    officialLeaderboardScore: false,
    groupsPlanned: plan.groups.length,
    independentPersonas: new Set(plan.groups.map((g) => g.persona)).size,
    groupsCompleted: records.filter((r) => r.status === "completed").length,
    arms,
    pairedGainVsNoHistory:
      arms.memory.accuracy !== null && arms["no-history"].accuracy !== null
        ? arms.memory.accuracy - arms["no-history"].accuracy
        : null,
    gapVsFullHistory:
      arms.memory.accuracy !== null && arms["full-history"].accuracy !== null
        ? arms.memory.accuracy - arms["full-history"].accuracy
        : null,
    preparationUsage: summarizeCalls(prepCalls),
    preparations: records.map((r) => ({
      group: r.group,
      status: r.status,
      ...r.result?.preparation,
      checkpoints: r.progress.filter((p) => p.type === "checkpoint"),
    })),
    billedCost: null,
    limitations: plan.protocol.limitations,
  };
}
export function summarizeCalls(calls) {
  const known = calls.filter((c) => Number.isFinite(c.usage?.totalTokens));
  return {
    hostCalls: calls.length,
    callsWithKnownTokens: known.length,
    callsWithUnknownTokens: calls.length - known.length,
    knownTokens: known.length
      ? known.reduce((n, c) => n + c.usage.totalTokens, 0)
      : null,
    elapsedMsInclusive: calls.reduce((n, c) => n + c.elapsedMs, 0),
    outcomes: calls.reduce((o, c) => {
      o[c.outcome] = (o[c.outcome] ?? 0) + 1;
      return o;
    }, {}),
  };
}
export async function fingerprint(root = ROOT) {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) await walk(rel);
      else if (e.isFile()) files.push(rel);
    }
  };
  await walk("src");
  for (const f of await readdir(join(root, "evaluation")))
    if (f.endsWith(".mjs")) files.push(join("evaluation", f));
  const manifest = await installationManifests(root);
  for (const file of files.sort())
    manifest.push({ file, sha256: hash(await readFile(join(root, file))) });
  return { sha256: hash(JSON.stringify(manifest)), files: manifest };
}
export async function runMemoryGroup(
  input,
  {
    directory,
    codex,
    backgroundCodex,
    timeoutMs,
    onRecord,
    referenceDirectory,
  },
) {
  return new Promise((resolvePromise) => {
    const worker = fork(
      new URL("./memory-system-worker.mjs", import.meta.url),
      [],
      {
        execArgv: [],
        detached: true,
        env: { PATH: process.env.PATH ?? "", HOME: directory, LANG: "C.UTF-8" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let result, workerError;
    const stop = () => {
      if (!Number.isSafeInteger(worker.pid)) return;
      try {
        process.kill(-worker.pid, "SIGKILL");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    };
    const timer = setTimeout(stop, timeoutMs + 2000);
    worker.on("message", (message) => {
      if (message.kind === "progress") onRecord(message.record);
      else if (message.kind === "result") result = message;
    });
    worker.on("error", () => {
      workerError = true;
    });
    worker.on("close", (code, signal) => {
      clearTimeout(timer);
      stop();
      resolvePromise(
        result?.ok && code === 0
          ? { status: "completed", result: result.result }
          : {
              status: "failed",
              error:
                result?.error ??
                (signal
                  ? "worker-terminated"
                  : workerError
                    ? "worker-error"
                    : "worker-exit"),
            },
      );
    });
    worker.send({
      input,
      directory,
      codex,
      backgroundCodex,
      timeoutMs,
      referenceDirectory,
    });
  });
}
// Controls have a separate process/profile/deadline so slow memory ingestion
// cannot consume their evaluation window. No state is shared between the legs.
export async function runMemoryGroupWithControls(
  input,
  options,
  run = runMemoryGroup,
) {
  const legs = [];
  for (const [name, arms, timeoutMs] of [
    ["controls", ["full-history", "no-history"], options.controlTimeoutMs],
    ["memory", ["memory"], options.timeoutMs],
  ]) {
    const progress = [];
    const result = await run(
      { ...input, arms },
      {
        ...options,
        directory: join(options.directory, name),
        timeoutMs,
        onRecord: (r) => {
          progress.push(r);
          options.onRecord(r);
        },
      },
    );
    legs.push({ name, ...result, progress });
  }
  const extract = (leg, field, type) =>
    leg.result?.[field] ??
    leg.progress
      .filter((p) => p.type === type)
      .map((p) => (type === "usage" ? p.call : p));
  const memory = legs[1];
  return {
    status: legs.every((leg) => leg.status === "completed")
      ? "completed"
      : "failed",
    result: {
      ...(memory.result ?? {}),
      results: legs.flatMap((leg) => extract(leg, "results", "answer")),
      calls: legs.flatMap((leg) => extract(leg, "calls", "usage")),
    },
    legs,
  };
}
async function main() {
  const { values: v } = parseArgs({
    options: {
      dataset: { type: "string" },
      output: { type: "string" },
      "codex-config": { type: "string" },
      "background-codex-config": { type: "string" },
      contexts: { type: "string", default: "1" },
      seed: {
        type: "string",
        default: "opencraft-memory-personamem-20261109-v1",
      },
      "timeout-ms": { type: "string", default: "900000" },
      "control-timeout-ms": { type: "string", default: "300000" },
      plan: { type: "boolean", default: false },
    },
  });
  if (!v.dataset || !v.output || !v["codex-config"])
    throw new Error(
      "Explicit dataset, new output and private codex-config required",
    );
  const timeoutMs = Number(v["timeout-ms"]),
    controlTimeoutMs = Number(v["control-timeout-ms"]);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 3600000 ||
    !Number.isSafeInteger(controlTimeoutMs) ||
    controlTimeoutMs < 1000 ||
    controlTimeoutMs > 3600000
  )
    throw new Error("Invalid group timeout");
  const dataset = resolve(v.dataset),
    directory = resolve(v.output);
  const questionsBytes = await readFile(join(dataset, "questions_32k.csv")),
    contextsBytes = await readFile(join(dataset, "shared_contexts_32k.jsonl"));
  const contexts = parseContexts(contextsBytes.toString("utf8"));
  const rows = validateQuestions(
    parseCsv(questionsBytes.toString("utf8")),
    contexts,
  );
  const groups = selectQuestions(rows, Number(v.contexts), v.seed);
  const { codex } = await readCodexConfiguration(v["codex-config"]);
  const backgroundCodex = v["background-codex-config"]
    ? (await readCodexConfiguration(v["background-codex-config"])).codex
    : undefined;
  const source = await fingerprint();
  const plan = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    suite: "PersonaMem-v1-32k-memory-component-pilot",
    target: "grokbot-derived-memory-scheme",
    seed: v.seed,
    concurrency: 1,
    timeoutMsPerGroup: timeoutMs + controlTimeoutMs,
    deadlines: { memoryMs: timeoutMs, controlsMs: controlTimeoutMs },
    dataset: {
      questionsSha256: hash(questionsBytes),
      contextsSha256: hash(contextsBytes),
      provenance: JSON.parse(
        await readFile(join(dataset, "source.json"), "utf8"),
      ),
      totalQuestions: rows.length,
      totalContexts: contexts.size,
      scorerSha256: hash(
        await readFile(join(dataset, "official-inference.py")),
      ),
    },
    source,
    model: {
      harness: "codex",
      modelId: codex.modelId,
      baseUrl: codex.baseUrl,
      binarySha256: hash(await readFile(codex.binary)),
      requiredCodexVersion: SUPPORTED_CODEX_VERSION,
    },
    backgroundModel: backgroundCodex
      ? {
          harness: "codex",
          modelId: backgroundCodex.modelId,
          baseUrl: backgroundCodex.baseUrl,
          reasoningEffort: backgroundCodex.reasoningEffort ?? null,
          binarySha256: hash(await readFile(backgroundCodex.binary)),
        }
      : {
          inheritsReader: true,
          reasoningEffort: codex.reasoningEffort ?? null,
        },
    protocol: {
      arms: MEMORY_ARMS,
      readerInstructionSha256: hash(READER_INSTRUCTION),
      sameReaderAcrossArms: true,
      controlScheduling:
        "independent-profile-and-deadline-controls-before-memory",
      learning:
        "original-MemoryLearningService-MemoryLearningModel-independent-verifier-file-authority",
      ingestion:
        "chronological-bursts-at-most-12-exchanges-native-default-policy-virtual-idle-drain-at-query-prefix",
      questionWritesMemory: false,
      goldToWorker: false,
      rawHistoryFallbackInMemoryArm: false,
      contextSummary: false,
      temporalMaintenance: false,
      systemPersona:
        "causal-prefix-context-shared-identically-across-all-arms-not-user-evidence",
      scoring: "official-extract_answer-JavaScript-port-no-LLM-judge",
      limitations: [
        "One or a few conversation groups are a wiring pilot, not representative benchmark or leaderboard evidence.",
        "Scores evaluate the derived memory component with a fixed reader, not the model or complete assistant.",
        "Memory-only excludes working context and original-history fallback; full assistant has additional capabilities.",
        "Native 15s debounce/12-exchange merge is exercised on a declared virtual arrival schedule; preparation wall time excludes real idle time.",
        "Dataset-provided system personas are common reader background, not user facts or learned memory. Exact roles/content are retained.",
        "Questions never enter learning. Source prefixes are used causally and same-prefix queries cannot mutate memory.",
        "Data includes no machine timestamps; monotonic UTC clock starts 2026-11-09. Content dates are unchanged; no temporal maintenance.",
        "Observed token counters can be incomplete and preparation is shared across queries; no billed-price estimate.",
        "No original Grokbot implementation is executed; parity is with inspected non-official source, not a head-to-head official product comparison.",
        "PersonaMem does not validate explicit forgetting, semantic non-resurrection, privacy erasure or multi-human authorization.",
      ],
    },
    groups: groups.map((g) => ({
      ...g,
      missingCategories: PERSONAMEM_TYPES.filter(
        (t) => !g.questions.some((q) => q.question_type === t),
      ),
      plannedMessages: projectGroup(g, contexts).history.length,
    })),
  };
  if (v.plan) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "plan.json"), JSON.stringify(plan, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  for (const { file, sourceFile = file } of source.files) {
    const target = join(directory, "source", file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(ROOT, sourceFile), target);
  }
  for (const file of ["source.json", "official-inference.py"])
    await copyFile(join(dataset, file), join(directory, file));
  const records = [];
  const save = () =>
    writeFile(
      join(directory, "score.json"),
      JSON.stringify(summarizeMemoryRun(plan, records), null, 2),
      { mode: 0o600 },
    );
  await save();
  for (let group = 0; group < groups.length; group++) {
    const progress = [],
      started = Date.now();
    const result = await runMemoryGroupWithControls(
      projectGroup(groups[group], contexts),
      {
        directory: join(directory, `profile-${group}`),
        codex,
        backgroundCodex,
        timeoutMs,
        controlTimeoutMs,
        onRecord: (record) => {
          progress.push(record);
          appendFileSync(
            join(directory, `progress-${group}.jsonl`),
            JSON.stringify(record) + "\n",
            { mode: 0o600 },
          );
          if (["batch", "answer"].includes(record.type))
            console.log(
              JSON.stringify({
                group,
                type: record.type,
                state: record.state,
                arm: record.arm,
                query: record.query,
                status: record.status,
                elapsedMs: record.elapsedMs,
              }),
            );
        },
      },
    );
    const record = {
      group,
      ...result,
      progress,
      elapsedMs: Date.now() - started,
    };
    records.push(record);
    await writeFile(
      join(directory, `group-${group}.json`),
      JSON.stringify(record, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    await save();
  }
  const after = await fingerprint();
  if (after.sha256 !== source.sha256)
    throw new Error(
      "Source changed during evaluation; retained evidence requires review",
    );
  console.log(
    JSON.stringify({ directory, ...summarizeMemoryRun(plan, records) }),
  );
  if (
    records.some(
      (r) =>
        r.status !== "completed" ||
        r.result.results.some((a) => a.status !== "completed"),
    )
  )
    process.exitCode = 2;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
