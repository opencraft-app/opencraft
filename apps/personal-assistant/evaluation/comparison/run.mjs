import { readFile, writeFile, mkdir, readdir, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import { execFileSync } from "node:child_process";
import {
  parseCsv,
  parseContexts,
  validateQuestions,
  selectQuestions,
  projectGroup,
  scoreOption,
  hash,
} from "../personamem-data.mjs";
import { runMemoryGroup } from "../memory-system.mjs";
import { foreignSession } from "./foreign-session.mjs";
import { service } from "./processes.mjs";
import { nativeText } from "./native-text.mjs";
const lab = resolve(import.meta.dirname, "../.."),
  root = resolve(lab, "..");
const output = resolve(process.argv[2] ?? join(lab, "evaluation/runs/tencent-memory-comparison-20261109-v3"));
await mkdir(output);
const codex = JSON.parse(await readFile(join(root, ".private/tokenhub-codex.json"), "utf8")),
  backgroundCodex = JSON.parse(await readFile(join(root, ".private/tokenhub-hy4-nothink-codex.json"), "utf8"));
const dataset = join(lab, "evaluation/datasets/personamem-v1-32k");
const csv = await readFile(join(dataset, "questions_32k.csv"), "utf8"),
  jsonl = await readFile(join(dataset, "shared_contexts_32k.jsonl"), "utf8");
const contexts = parseContexts(jsonl),
  rows = validateQuestions(parseCsv(csv), contexts);
const previous = JSON.parse(
  await readFile(join(lab, "evaluation/runs/memory-personamem-contract-hy4-none-20261109-v1/plan.json"), "utf8"),
);
const regression = previous.groups[0],
  seed = "tencent-memory-comparison-20261109-v2";
const unseen = selectQuestions(
  rows.filter((r) => r.shared_context_id !== regression.id),
  2,
  seed,
);
const groups = [
  { ...regression, role: "known-regression" },
  ...unseen.map((g, i) => ({ ...g, role: "unseen-persona-" + (i + 1) })),
];
const sourceFiles = [];
async function walk(dir) {
  for (const e of await readdir(join(lab, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (e.isFile() && /\.(mjs|py)$/.test(p))
      sourceFiles.push({ file: p, sha256: hash(await readFile(join(lab, p))) });
  }
}
await walk("src");
for (const e of await readdir(join(lab, "evaluation"), { withFileTypes: true }))
  if (e.isFile() && e.name.endsWith(".mjs"))
    sourceFiles.push({
      file: "evaluation/" + e.name,
      sha256: hash(await readFile(join(lab, "evaluation", e.name))),
    });
await walk("evaluation/comparison");
sourceFiles.sort((a, b) => a.file.localeCompare(b.file));
const pin = (dir) => ({
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: join(root, dir),
    encoding: "utf8",
  }).trim(),
  trackedChanges: execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: join(root, dir),
    encoding: "utf8",
  }).trim(),
});
const configPin = (c) => ({
  model: c.modelId,
  baseUrl: c.baseUrl,
  reasoningEffort: c.reasoningEffort ?? "provider-default",
  binarySha256: execFileSync("/usr/bin/sha256sum", [c.binary], {
    encoding: "utf8",
  }).split(" ")[0],
});
const plan = {
  createdAt: new Date().toISOString(),
  seed,
  officialLeaderboardScore: false,
  target: "three-memory-systems-common-backbone-pilot",
  groups,
  models: { reader: configPin(codex), background: configPin(backgroundCodex) },
  embedding: {
    model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    provider: "fastembed-0.9.1-local-onnx-cpu",
    dimensions: 384,
    inputTokenLimit: 128,
    sharedBy: ["hy", "tdb"],
    ours: "unchanged lexical tools, no embedding added",
  },
  systems: {
    ours: { sourceSha256: hash(JSON.stringify(sourceFiles)) },
    hy: {
      ...pin("tencent-hy-memory"),
      mode: "pro",
      reader: "hybrid",
      graph: false,
      localRerank: false,
      agenticSearch: false,
    },
    tdb: {
      ...pin("tencentdb-agent-memory"),
      mode: "standalone-local",
      retrieval: "hybrid",
      offlineDrain:
        "upstream L1 runners at ingestion boundaries; upstream L2/L3 runners at causal query checkpoints; native L3 trigger retained",
    },
  },
  dataset: {
    questionsSha256: hash(csv),
    contextsSha256: hash(jsonl),
    upstream: previous.dataset,
  },
  protocol: {
    memoryMsPerSystemGroup: 900000,
    controlsMsPerGroup: 300000,
    nativeModelCallCeilingMs: 120000,
    sourceBatchExchanges: 12,
    queryRounds: 7,
    queries: 6,
    initialContextBytes: 128000,
    queryResultBytes: 12000,
    totalQueryResultBytes: 48000,
    rawHistoryInMemoryArms: false,
    repetitions: 1,
    readerInstructionSha256: hash(await readFile(join(lab, "evaluation/memory-system-session.mjs"))),
    limitations: [
      "Small pilot: one previously inspected history and two independently selected unseen histories; no leaderboard or statistical superiority claim.",
      "Common reader and background models/harness, but native prompts, scheduling granularity, extraction, retrieval and representations differ; this compares systems, not a single causal mechanism.",
      "Common embedding is multilingual MiniLM (128-token input truncation); not vendor best reported embedding. Our lexical system remains unchanged.",
      "Foreign model transport uses the same native Codex backend; TDB L2/L3 use a host-neutral native Codex runner with upstream sandbox file tools; the upstream tool factory is exposed by a generated copy adding only an export. L1/Hy use a text-only OpenAI-compatible bridge to the same native backend.",
      "Native requested temperature and max_tokens are logged; Codex native settings retain none/background and provider-default/reader, no claim of deterministic decoding or exact output-token ceilings.",
      "System API names and structured schemas retain native meaning; same reader instructions and host budgets.",
      "No raw conversation search in memory arms. Full-history and no-history controls are separate.",
      "Whole-run timeouts and partial failures remain visible; no score-dependent retry or prompt tuning.",
      "Physical memory time uses shared synthetic dated source ingestion; wall-clock service dates remain actual today.",
      "TDB L2/L3 drains are offline checkpoints, not an online freshness/latency claim.",
    ],
  },
};
await writeFile(join(output, "plan.json"), JSON.stringify(plan, null, 2));
await writeFile(join(output, "source.json"), JSON.stringify(sourceFiles, null, 2));
console.log(
  JSON.stringify({
    event: "plan-frozen",
    output,
    groups: groups.map((g) => ({
      role: g.role,
      questions: g.questions.length,
      messages: Math.max(...g.questions.map((q) => Number(q.end_index_in_shared_context))),
    })),
  }),
);
const results = [],
  services = [];
const save = async () => {
  const score = {
    createdAt: new Date().toISOString(),
    plannedQuestions: groups.reduce((n, g) => n + g.questions.length, 0),
    systems: {},
    records: results.map(({ result, ...r }) => ({
      ...r,
      answers: result?.results,
    })),
  };
  for (const system of ["ours", "hy", "tdb", "full-history", "no-history"]) {
    const records = results.filter((r) => r.system === system),
      answers = records.flatMap((r) =>
        (r.result?.results ?? r.progress.filter((p) => p.type === "answer"))
          .filter((a) => (system === "full-history" || system === "no-history" ? a.arm === system : a.arm === "memory"))
          .map((a) => ({ ...a, group: r.group })),
      );
    const correct = answers.filter(
      (a) => a.status === "completed" && scoreOption(a.hypothesis, groups[a.group].questions[a.query].correct_answer),
    ).length;
    score.systems[system] = {
      planned: score.plannedQuestions,
      returned: answers.filter((a) => a.status === "completed").length,
      correct,
      failed: answers.filter((a) => a.status !== "completed").length,
      pending: score.plannedQuestions - answers.length,
      accuracy: answers.length === score.plannedQuestions ? correct / score.plannedQuestions : null,
      byGroup: groups.map((g, i) => {
        const selected = answers.filter((a) => a.group === i);
        return {
          role: g.role,
          planned: g.questions.length,
          returned: selected.filter((a) => a.status === "completed").length,
          correct: selected.filter(
            (a) => a.status === "completed" && scoreOption(a.hypothesis, g.questions[a.query].correct_answer),
          ).length,
        };
      }),
      preparationMs: records.map((r) => r.result?.preparation?.elapsedMs ?? null),
      readerCalls: records.flatMap((r) => r.result?.calls ?? []).filter((c) => c.kind === "reception").length,
    };
  }
  await writeFile(join(output, "score.json"), JSON.stringify(score, null, 2));
};
try {
  const preflightStart = performance.now();
  try {
    const ready = await nativeText(backgroundCodex, {
      instruction: "Reply READY only.",
      messages: [
        {
          role: "user",
          content: "Connection readiness check, no dataset input.",
        },
      ],
      signal: AbortSignal.timeout(30000),
    });
    await writeFile(
      join(output, "model-readiness.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          model: backgroundCodex.modelId,
          reasoningEffort: backgroundCodex.reasoningEffort,
          status: "returned",
          usage: ready.usage,
          elapsedMs: performance.now() - preflightStart,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    await writeFile(
      join(output, "model-readiness.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          model: backgroundCodex.modelId,
          status: "failed",
          error: e.nativeError ?? { name: e.name, message: e.message },
          elapsedMs: performance.now() - preflightStart,
        },
        null,
        2,
      ),
    );
    throw e;
  }
  const bridge = await service(
    "/opt/opencraft/bin/node",
    [
      join(import.meta.dirname, "bridge.mjs"),
      join(root, ".private/tokenhub-hy4-nothink-codex.json"),
      join(output, "background"),
    ],
    { cwd: lab, log: join(output, "bridge.log") },
  );
  services.push(bridge);
  const embed = await service(
    join(root, ".benchmark-tools/hy-env/bin/python"),
    [join(import.meta.dirname, "embedding-server.py"), join(root, ".benchmark-tools/embedding-cache")],
    {
      cwd: lab,
      log: join(output, "embedding.log"),
      env: { HOME: join(output, "embedding-home"), HF_HUB_OFFLINE: "1" },
    },
  );
  services.push(embed);
  for (let g = 0; g < groups.length; g++) {
    const input = projectGroup(groups[g], contexts);
    const order = g % 2 ? ["tdb", "ours", "hy"] : ["ours", "hy", "tdb"];
    for (const system of ["controls", ...order]) {
      const directory = join(output, `group-${g}-${system}`);
      await mkdir(directory, { recursive: true });
      const progress = [];
      const onRecord = async (p) => {
        progress.push(p);
        await appendFile(join(directory, "progress.jsonl"), JSON.stringify(p) + "\n");
        if (["answer", "batch", "checkpoint"].includes(p.type))
          console.log(
            JSON.stringify({
              event: p.type,
              group: g,
              system,
              query: p.query,
              status: p.status,
              state: p.state,
              end: p.end,
            }),
          );
      };
      console.log(JSON.stringify({ event: "starting", group: g, system }));
      await fetch("http://127.0.0.1:" + bridge.info.port + "/label", {
        method: "POST",
        body: JSON.stringify({ label: `group-${g}-${system}` }),
      });
      const started = performance.now();
      let record;
      if (system === "ours" || system === "controls") {
        const value = await runMemoryGroup(
          {
            ...input,
            arms: system === "ours" ? ["memory"] : ["full-history", "no-history"],
          },
          {
            directory,
            codex,
            backgroundCodex,
            timeoutMs: system === "ours" ? 900000 : 300000,
            onRecord,
          },
        );
        record = {
          group: g,
          system,
          ...value,
          progress,
          elapsedMs: performance.now() - started,
        };
      } else {
        try {
          const result = await foreignSession(input, {
            name: system,
            directory,
            codex,
            bridge: "http://127.0.0.1:" + bridge.info.port,
            embedding: "http://127.0.0.1:" + embed.info.port,
            backgroundModel: backgroundCodex.modelId,
            signal: AbortSignal.timeout(900000),
            onRecord,
          });
          record = {
            group: g,
            system,
            status: "completed",
            result,
            progress,
            elapsedMs: performance.now() - started,
          };
        } catch (e) {
          record = {
            group: g,
            system,
            status: "failed",
            error: e.code ?? e.name,
            message: e.message.slice(0, 300),
            progress,
            elapsedMs: performance.now() - started,
          };
        }
      }
      await writeFile(join(directory, "result.json"), JSON.stringify(record, null, 2));
      if (system === "controls") {
        for (const s of ["full-history", "no-history"]) results.push({ ...record, system: s });
      } else results.push(record);
      await save();
      console.log(
        JSON.stringify({
          event: "finished",
          group: g,
          system,
          status: record.status,
          elapsedMs: record.elapsedMs,
        }),
      );
    }
  }
} catch (e) {
  await writeFile(join(output, "fatal.json"), JSON.stringify({ name: e.name, message: e.message.slice(0, 300) }));
  process.exitCode = 1;
} finally {
  services.forEach((s) => s.close());
  await save();
  await writeFile(
    join(output, "completed.json"),
    JSON.stringify({
      completedAt: new Date().toISOString(),
      allGroupsSettled: results.length === groups.length * 5,
    }),
  );
}
