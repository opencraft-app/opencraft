import { readFile, writeFile, mkdir, readdir, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import { execFileSync } from "node:child_process";
import { parseContexts, projectGroup, scoreOption, hash } from "../personamem-data.mjs";
import { runMemoryGroup } from "../memory-system.mjs";
import { foreignSession } from "./foreign-session.mjs";
import { service } from "./processes.mjs";
import { nativeText } from "./native-text.mjs";
const lab = resolve(import.meta.dirname, "../.."),
  root = resolve(lab, "..");
const output = resolve(process.argv[2] ?? join(lab, "evaluation/runs/hindsight-comparison-20261110-v1"));
await mkdir(output);
const codex = JSON.parse(await readFile(join(root, ".private/tokenhub-codex.json"), "utf8")),
  backgroundCodex = JSON.parse(await readFile(join(root, ".private/tokenhub-hy4-nothink-codex.json"), "utf8"));
const dataset = join(lab, "evaluation/datasets/personamem-v1-32k");
const csv = await readFile(join(dataset, "questions_32k.csv"), "utf8"),
  jsonl = await readFile(join(dataset, "shared_contexts_32k.jsonl"), "utf8");
const contexts = parseContexts(jsonl);
const previous = JSON.parse(await readFile(join(lab, "evaluation/runs/bm25-paired-20261109-v1/plan.json"), "utf8"));
if (hash(csv) !== previous.dataset.questionsSha256 || hash(jsonl) !== previous.dataset.contextsSha256)
  throw new Error("Dataset hash mismatch");
const groups = previous.groups,
  seed = "hindsight-comparison-20261110-v1";
if (
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: lab,
    encoding: "utf8",
  }).trim()
)
  throw new Error("Committed source required");
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
  target: "hindsight-vs-markdown-bm25-memory-subsystems",
  groups,
  models: { reader: configPin(codex), background: configPin(backgroundCodex) },
  embedding: {
    model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    provider: "fastembed-0.9.1-local-onnx-cpu",
    dimensions: 384,
    inputTokenLimit: 128,
    sharedBy: ["hindsight"],
    ours: "unchanged lexical tools, no embedding added",
  },
  systems: {
    ours: {
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: lab,
        encoding: "utf8",
      }).trim(),
      sourceSha256: hash(JSON.stringify(sourceFiles)),
      memory: "Markdown authority with rebuildable FTS5 BM25 index",
    },
    hindsight: {
      ...pin("hindsight-reference"),
      version: "1.2.0",
      retrieval: "native four-way/RRF",
      reranker: "rrf",
      observations: true,
      consolidation: "upstream SyncTaskBackend",
      reflect: false,
      recallMaxTokens: 4096,
      topK: 12,
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
      "Known 17-question/3-persona regression, one repetition; not held-out, no leaderboard or significance claim.",
      "All arms are fresh runs. Reader is DeepSeek Flash via native Codex; background is hy4/none via the same native Codex backend. No official frontier-model score reproduction.",
      "Common reader instruction, transcript prefixes and host budgets. Native extraction, consolidation, representation and retrieval differ, so this is a system comparison rather than one-mechanism ablation.",
      "Hindsight retains role-labelled source conversations and uses its own world/experience/observation extraction. It does not use our MemoryLearningService verifier or Markdown facts.",
      "Hindsight uses native semantic/BM25/graph/temporal retrieval with RRF and the same local multilingual MiniLM 384d/128-token encoder as earlier Tencent pilots. Neural reranking disabled; not its recommended best configuration.",
      "Native Hindsight return capped at first 12 facts without reordering; max_tokens4096; raw chunks never exposed. No custom reranking or question-driven extraction.",
      "Hindsight observations run synchronously using upstream embedded task backend, preparation includes their cost. No reflect model; common reader performs final answering.",
      "Container NSS user mapping and pg0 connection URI fallback are process-local infrastructure, not memory policy. PostgreSQL and source artifacts remain isolated.",
      "Per-group 900s deadline and per-native-call120s; failures and partial records retained. No score-dependent retries or prompt tuning.",
      "Known contradictory music-preference gold item retained unchanged; audit separately from strict score.",
      "Reported token usage is observed rather than billed price. Native Codex does not enforce upstream temperature/max_tokens; requested settings are logged.",
    ],
  },
};
await writeFile(join(output, "plan.json"), JSON.stringify(plan, null, 2));
await writeFile(join(output, "source.json"), JSON.stringify(sourceFiles, null, 2));
await writeFile(
  join(output, "python-environment.txt"),
  execFileSync(
    join(root, ".benchmark-tools/uv-x86_64-unknown-linux-gnu/uv"),
    ["pip", "freeze", "--python", join(root, ".benchmark-tools/hindsight-env/bin/python")],
    { encoding: "utf8" },
  ),
);
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
  for (const system of ["ours", "hindsight", "full-history", "no-history"]) {
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
    const order = g % 2 ? ["hindsight", "ours"] : ["ours", "hindsight"];
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
      allGroupsSettled: results.length === groups.length * 4,
    }),
  );
}
