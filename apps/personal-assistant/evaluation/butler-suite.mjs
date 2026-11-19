import { parseArgs } from "node:util";
import { fork, execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadProfile } from "../src/profile.mjs";
import { cases, coreCases } from "./butler-cases.mjs";
import { extendedCases } from "./butler-extended-cases.mjs";

import { complexCases } from "./butler-complex-cases.mjs";

const root = resolve(import.meta.dirname, "..");
export function summarize(results, selected) {
  const counts = { passed: 0, failed: 0, timeout: 0, not_run: 0 };
  for (const c of selected) counts[results.find((r) => r.id === c.id)?.state ?? "not_run"]++;
  return {
    counts,
    total: selected.length,
    modelQualityScore: null,
    semanticReview: "unverified",
  };
}
const hash = (data) => createHash("sha256").update(data).digest("hex");
export function selectCases({ only, group = "all" } = {}) {
  if (!["all", "core", "extended", "complex"].includes(group)) throw new Error("Unknown group");
  if (only && group !== "all") throw new Error("Use either case or group");
  const selected = only
    ? cases.filter((c) => c.id === only)
    : group === "core"
      ? coreCases
      : group === "extended"
        ? extendedCases
        : group === "complex"
          ? complexCases
          : cases;
  if (!selected.length) throw new Error("Unknown case");
  return selected;
}
export async function runSuite({
  output,
  mode = "fixture",
  modelProfile,
  only,
  group,
  timeoutMs = 240000,
  failureLimit = 2,
}) {
  if (!["fixture", "model"].includes(mode)) throw new Error("mode must be fixture or model");
  const selected = selectCases({ only, group });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error("Invalid timeout-ms");
  if (!Number.isSafeInteger(failureLimit) || failureLimit < 1 || failureLimit > cases.length)
    throw new Error("Invalid failure-limit");
  let harnesses;
  if (mode === "model") {
    if (!modelProfile) throw new Error("Model mode requires --model-profile; no implicit credentials");
    const source = loadProfile(modelProfile);
    if (
      source.config.mode !== "model" ||
      source.config.harnesses?.assistant !== "codex" ||
      source.config.harnesses?.execution !== "codex"
    )
      throw new Error("Explicit all-Codex model profile required");
    harnesses = source.config.harnesses;
  } else if (modelProfile) throw new Error("Fixture mode does not accept model credentials");
  const files = execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "src", "bin", "evaluation/*.mjs", "package.json", "package-lock.json"],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const fingerprints = {};
  for (const path of [...new Set(files)].sort()) fingerprints[path] = hash(await readFile(join(root, path)));
  const plan = {
    suite: "synthetic-butler-v5",
    group: only ? "single" : (group ?? "all"),
    createdAt: new Date().toISOString(),
    mode,
    selected,
    timeoutMs,
    failureLimit,
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceDirty: !!execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceHash: hash(JSON.stringify(fingerprints)),
    fingerprints,
    models: harnesses
      ? Object.fromEntries(
          Object.entries(harnesses).map(([key, value]) => [
            key,
            typeof value === "object"
              ? {
                  modelId: value.modelId,
                  baseUrl: value.baseUrl,
                  reasoningEffort: value.reasoningEffort ?? "provider-default",
                }
              : value,
          ]),
        )
      : { mode: "fixture" },
    nativeVersion: harnesses
      ? execFileSync(harnesses.codex.binary, ["--version"], {
          encoding: "utf8",
        }).trim()
      : null,
    protocol: "local-socket",
    memoryLearningEnabled: false,
    concurrency: 2,
    caseConcurrency: 1,
    retryPolicy: "No evaluator retry or corrective hints; original production retries remain",
    nativeProfileIsolation: true,
    runPolicy: { modelTimeoutMs: 60000, workTimeoutMs: 120000, maxSteps: 16 },
  };
  output = resolve(output);
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, "plan.json"), JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });
  const results = [];
  let failures = 0;
  for (const c of selected) {
    if (failures >= failureLimit) {
      results.push({
        id: c.id,
        state: "not_run",
        reason: "Predeclared failure gate",
      });
      continue;
    }
    console.log(JSON.stringify({ case: c.id, state: "started", mode }));
    const outcome = await new Promise((resolveRun) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => ["PATH", "HOME", "TMPDIR", "LANG", "TZ"].includes(k)),
      );
      const child = fork(join(import.meta.dirname, "butler-worker.mjs"), [], {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let reply,
        stdout = "",
        stderr = "",
        timedOut = false;
      const kill = () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      child.stdout.on("data", (x) => {
        stdout = (stdout + x).slice(-64000);
      });
      child.stderr.on("data", (x) => {
        stderr = (stderr + x).slice(-64000);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs + 15000);
      child.on("message", (m) => {
        reply = m;
      });
      child.once("error", (e) => {
        reply = { state: "failed", error: e.message };
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        kill();
        resolveRun({
          id: c.id,
          ...(reply ?? {
            state: "failed",
            error: "Worker exited without report",
          }),
          ...(timedOut ? { state: "timeout" } : {}),
          code,
          signal,
          stdout,
          stderr,
        });
      });
      child.send({ id: c.id, mode, harnesses, output, timeoutMs });
    });
    results.push(outcome);
    if (["failed", "timeout"].includes(outcome.state)) failures++;
    else if (outcome.state === "passed") failures = 0;
    await writeFile(
      join(output, "summary.json"),
      JSON.stringify({ ...summarize(results, selected), results }, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ case: c.id, state: outcome.state }));
  }
  const summary = { ...summarize(results, selected), results };
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({
    options: {
      mode: { type: "string", default: "fixture" },
      output: { type: "string" },
      "model-profile": { type: "string" },
      case: { type: "string" },
      group: { type: "string" },
      "timeout-ms": { type: "string" },
      "failure-limit": { type: "string" },
    },
  });
  if (!v.output) throw new Error("--output NEW_DIRECTORY is required");
  const summary = await runSuite({
    output: v.output,
    mode: v.mode,
    modelProfile: v["model-profile"],
    only: v.case,
    group: v.group,
    timeoutMs: Number(v["timeout-ms"] ?? 240000),
    failureLimit: Number(v["failure-limit"] ?? 2),
  });
  console.log(
    JSON.stringify({
      output: resolve(v.output),
      counts: summary.counts,
      modelQualityScore: null,
    }),
  );
  if (summary.counts.failed || summary.counts.timeout) process.exitCode = 1;
}
