// Fixed-plan read-side ablation. Both readers use the SAME native learning state.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { runMemoryGroup, summarizeCalls } from "./memory-system.mjs";
import {
  parseContexts,
  projectGroup,
  scoreOption,
  hash,
} from "./personamem-data.mjs";
const { values } = parseArgs({
  options: {
    plan: { type: "string" },
    contexts: { type: "string" },
    output: { type: "string" },
    reference: { type: "string" },
    "codex-config": { type: "string" },
    "background-codex-config": { type: "string" },
  },
});
for (const key of [
  "plan",
  "contexts",
  "output",
  "reference",
  "codex-config",
  "background-codex-config",
])
  if (!values[key]) throw new Error("Missing explicit --" + key);
const lab = resolve(import.meta.dirname, ".."),
  reference = resolve(values.reference),
  output = resolve(values.output);
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
if (
  git(lab, "status", "--porcelain", "--untracked-files=no") ||
  git(reference, "status", "--porcelain", "--untracked-files=no")
)
  throw new Error("Committed clean source required");
const prior = JSON.parse(await readFile(values.plan));
const contextRaw = await readFile(values.contexts, "utf8");
if (hash(contextRaw) !== prior.dataset.contextsSha256)
  throw new Error("Context hash changed");
const contexts = parseContexts(contextRaw),
  codex = JSON.parse(await readFile(values["codex-config"])),
  backgroundCodex = JSON.parse(
    await readFile(values["background-codex-config"]),
  );
const identity = async (c) => ({
  model: c.modelId,
  baseUrl: c.baseUrl,
  reasoningEffort: c.reasoningEffort ?? "provider-default",
  binarySha256: hash(await readFile(c.binary)),
});
for (const [key, c] of [
  ["reader", codex],
  ["background", backgroundCodex],
])
  if (JSON.stringify(await identity(c)) !== JSON.stringify(prior.models[key]))
    throw new Error("Model/harness setting changed: " + key);
const revisions = {
  before: git(reference, "rev-parse", "HEAD"),
  after: git(lab, "rev-parse", "HEAD"),
};
await mkdir(output);
const sources = {};
for (const [name, cwd] of [
  ["before", reference],
  ["after", lab],
]) {
  sources[name] = [];
  for (const file of git(cwd, "ls-files")
    .split("\n")
    .filter((f) => f.endsWith(".mjs"))) {
    const raw = await readFile(join(cwd, file));
    sources[name].push({ file, sha256: hash(raw) });
    const target = join(output, "source-snapshot", name, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, raw);
  }
}
const plan = {
  createdAt: new Date().toISOString(),
  target: "same-learned-memory-read-side-ablation",
  groups: prior.groups,
  dataset: prior.dataset,
  models: prior.models,
  revisions,
  referenceDirectory: reference,
  protocol: {
    ...prior.protocol,
    arms: ["before", "after"],
    sharedLearning: true,
    questionOptionsUsedForRetrieval: false,
    sourceTextUsedForRecall: "current question only",
    readerInstructionUnchanged: true,
    timeoutMsPerGroup: 900000,
    order: "alternate before/after by question index",
    repetitions: 1,
    limitations: [
      "Known pilot, 17 questions / 3 personas; no blind-generalization or statistical-superiority claim.",
      "Native learning rerun once, shared by both variants at every causal checkpoint; not reused v3 learning or answers.",
      "Change scope is defined by the recorded before/after commits; reader projection and query instruction are taken from those versions, never relabeled as a one-change ablation without reviewing the diff.",
    ],
  },
};
await writeFile(join(output, "plan.json"), JSON.stringify(plan, null, 2));
await writeFile(join(output, "source.json"), JSON.stringify(sources, null, 2));
const records = [];
const save = async () => {
  const all = records.flatMap((r) =>
    (r.result?.results ?? r.progress.filter((p) => p.type === "answer")).map(
      (a) => ({ ...a, group: r.group }),
    ),
  );
  const calls = records.flatMap(
    (r) =>
      r.result?.calls ??
      r.progress.filter((p) => p.type === "usage").map((p) => p.call),
  );
  const summary = {
    at: new Date().toISOString(),
    revisions,
    planned: 17,
    groupsCompleted: records.filter((r) => r.status === "completed").length,
    variants: {},
    preparationUsage: summarizeCalls(
      calls.filter((c) => c.kind !== "reception"),
    ),
    preparations: records.map((r) => ({
      group: r.group,
      status: r.status,
      elapsedMs: r.elapsedMs,
      preparation: r.result?.preparation ?? null,
    })),
    pairs: [],
  };
  for (const variant of ["before", "after"]) {
    const rows = all.filter((a) => a.variant === variant),
      ids = new Set(rows.flatMap((a) => a.callIds ?? []));
    const completed = rows.filter((a) => a.status === "completed");
    const correct = completed.filter((a) =>
      scoreOption(
        a.hypothesis,
        plan.groups[a.group].questions[a.query].correct_answer,
      ),
    ).length;
    summary.variants[variant] = {
      planned: 17,
      returned: completed.length,
      correct,
      failed: rows.length - completed.length,
      pending: 17 - rows.length,
      accuracy: rows.length === 17 ? correct / 17 : null,
      readerUsage: summarizeCalls(calls.filter((c) => ids.has(c.id))),
      queries: rows.reduce((n, a) => n + (a.queries?.length ?? 0), 0),
      byGroup: plan.groups.map((g, i) => ({
        group: i,
        planned: g.questions.length,
        correct: completed.filter(
          (a) =>
            a.group === i &&
            scoreOption(
              a.hypothesis,
              plan.groups[a.group].questions[a.query].correct_answer,
            ),
        ).length,
      })),
    };
  }
  for (let group = 0; group < plan.groups.length; group++)
    for (let query = 0; query < plan.groups[group].questions.length; query++) {
      const answers = Object.fromEntries(
        ["before", "after"].map((v) => [
          v,
          all.find(
            (a) => a.group === group && a.query === query && a.variant === v,
          ),
        ]),
      );
      summary.pairs.push({
        group,
        query,
        type: plan.groups[group].questions[query].question_type,
        ...Object.fromEntries(
          Object.entries(answers).map(([v, a]) => [
            v,
            a
              ? {
                  status: a.status,
                  correct:
                    a.status === "completed" &&
                    scoreOption(
                      a.hypothesis,
                      plan.groups[group].questions[query].correct_answer,
                    ),
                  hypothesis: a.hypothesis,
                  error: a.error ?? null,
                  queries: a.queries?.length ?? 0,
                }
              : null,
          ]),
        ),
      });
    }
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
};
try {
  for (let group = 0; group < plan.groups.length; group++) {
    const directory = join(output, "group-" + group);
    await mkdir(directory);
    const progress = [];
    console.log(JSON.stringify({ event: "starting", group }));
    const started = performance.now();
    const response = await runMemoryGroup(
      { ...projectGroup(plan.groups[group], contexts), arms: ["memory"] },
      {
        directory,
        codex,
        backgroundCodex,
        referenceDirectory: reference,
        timeoutMs: 900000,
        onRecord: (p) => {
          progress.push(p);
          appendFileSync(
            join(directory, "progress.jsonl"),
            JSON.stringify(p) + "\n",
          );
          if (["batch", "answer", "checkpoint"].includes(p.type))
            console.log(
              JSON.stringify({
                event: p.type,
                group,
                query: p.query,
                variant: p.variant,
                status: p.status,
                state: p.state,
              }),
            );
        },
      },
    );
    const record = {
      group,
      ...response,
      progress,
      elapsedMs: performance.now() - started,
    };
    records.push(record);
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify(record, null, 2),
    );
    await save();
    console.log(
      JSON.stringify({ event: "finished", group, status: record.status }),
    );
  }
} finally {
  await save();
  await writeFile(
    join(output, "completed.json"),
    JSON.stringify(
      { at: new Date().toISOString(), allGroupsSettled: records.length === 3 },
      null,
      2,
    ),
  );
}
