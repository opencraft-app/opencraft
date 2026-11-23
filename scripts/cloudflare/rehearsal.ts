// Real-Cloudflare rehearsal of the workerd prototypes: `npm run cf:rehearsal`.
//
// Deploys the same prototype bundles the Miniflare tests run (plus an access
// guard) to a real Cloudflare account, runs the same shared scenarios against
// them and, for comparison, against Miniflare in this process; prints both
// outcomes side by side, then deletes every worker and R2 bucket it created
// and lists the account again to prove nothing of this run is left.
//
// Needs a real account, so it is not part of `test`, `gate` or CI.
//   CLOUDFLARE_ACCOUNT_ID   account to deploy to (required)
//   CLOUDFLARE_API_TOKEN    API token with Workers Scripts and R2 edit (required;
//                           any placeholder when a proxy injects the credential)
// Options:
//   --only <regex>          run only scenarios whose "group: name" matches
//   --skip-miniflare        do not run the local comparison
//   --report <file.json>    write the full results as JSON
//   --keep                  debugging only: keep the created resources
//   --stale-minutes <n>     before deploying, delete leftovers of earlier runs
//                           (opencraft-rehearsal-* only) unchanged for n minutes
//                           (default 10; 0 cleans every earlier run's leftovers)
// See docs/architecture/platform/cloudflare-deployment.md ("真实 Cloudflare 预演").
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { miniflareRuntime } from "../../tests/cloudflare/miniflare-runtime.ts";
import { SCENARIO_GROUPS } from "../../tests/cloudflare/scenarios.ts";
import type { WorkerRuntime, WorkerScenario } from "../../tests/cloudflare/worker-runtime.ts";
import { cleanLeftovers } from "./rehearsal-leftovers.ts";
import {
  CloudflareApi,
  cloudflareRuntime,
  REHEARSAL_PREFIX,
  type CloudflareRuntime,
  type InvocationTimes,
} from "./cloudflare-runtime.ts";

interface Outcome {
  readonly ok: boolean;
  readonly ms: number;
  readonly error?: string;
  readonly diagnostics: string[];
}
interface Row {
  readonly group: string;
  readonly name: string;
  miniflare?: Outcome;
  cloudflare?: Outcome;
}

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    "skip-miniflare": { type: "boolean", default: false },
    report: { type: "string" },
    keep: { type: "boolean", default: false },
    "stale-minutes": { type: "string", default: "10" },
  },
});

const log = (line: string) => console.log(`[cf:rehearsal] ${line}`);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!accountId || !/^[0-9a-f]{32}$/u.test(accountId) || !token) {
  console.error("cf:rehearsal needs CLOUDFLARE_ACCOUNT_ID (32 hex) and CLOUDFLARE_API_TOKEN.");
  process.exit(2);
}
const only = args.only ? new RegExp(args.only, "u") : undefined;
const staleMinutes = Number(args["stale-minutes"]);
if (!Number.isFinite(staleMinutes) || staleMinutes < 0) {
  console.error("--stale-minutes must be a non-negative number.");
  process.exit(2);
}

const api = new CloudflareApi(accountId, token);
// Earlier runs that could not clean up (SIGKILL, crash, --keep) are removed first.
const leftovers = await cleanLeftovers(api, { staleMinutes, log });
log(
  `leftovers of earlier runs: deleted ${leftovers.deletedWorkers.length} workers and ${leftovers.deletedBuckets.length} R2 buckets` +
    (leftovers.recent.length ? `, left ${leftovers.recent.length} recent` : ""),
);
if (leftovers.failures.length) {
  for (const failure of leftovers.failures) log(`LEFTOVER CLEANUP FAILED ${failure}`);
  process.exit(1);
}
const existingWorkers = await api.listWorkers();
const existingBuckets = await api.listBuckets();
log(
  `account has ${existingWorkers.length} workers and ${existingBuckets.length} R2 buckets before the run; none of them is touched`,
);

const scratch = await mkdtemp(join(tmpdir(), "cf-rehearsal-"));
const local = miniflareRuntime();
const cloud: CloudflareRuntime = await cloudflareRuntime({ api, log, existingWorkers, existingBuckets });
log(`run prefix ${cloud.run}`);

let cleaning: Promise<number> | undefined;
async function cleanup(): Promise<number> {
  return (cleaning ??= (async () => {
    await local.dispose().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    if (args.keep) {
      log(
        `--keep: leaving ${[...cloud.created.workers, ...cloud.created.buckets].join(", ") || "nothing"} for debugging; delete them by exact name afterwards`,
      );
      return 0;
    }
    const failures = await cloud.cleanup();
    for (const failure of failures) log(`CLEANUP FAILED ${failure}`);
    // Prove the account is back to its previous state.
    const workersAfter = await api.listWorkers();
    const bucketsAfter = await api.listBuckets();
    const leftovers = [...workersAfter, ...bucketsAfter].filter((name) => name.startsWith(REHEARSAL_PREFIX));
    const sameWorkers = JSON.stringify(workersAfter) === JSON.stringify(existingWorkers);
    const sameBuckets = JSON.stringify(bucketsAfter) === JSON.stringify(existingBuckets);
    log(
      `after cleanup: ${workersAfter.length} workers [${workersAfter.join(", ")}], ${bucketsAfter.length} R2 buckets [${bucketsAfter.join(", ")}]`,
    );
    log(
      `unchanged from before the run: workers ${sameWorkers}, buckets ${sameBuckets}; rehearsal leftovers: ${leftovers.length ? leftovers.join(", ") : "none"}`,
    );
    return failures.length || leftovers.length ? 1 : 0;
  })());
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    log(`${signal}: cleaning up before exit`);
    void cleanup().finally(() => process.exit(130));
  });
}
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.once(event, (error: unknown) => {
    log(`${event}: ${error instanceof Error ? error.stack : String(error)}; cleaning up before exit`);
    void cleanup().finally(() => process.exit(1));
  });
}

async function attempt(runtime: WorkerRuntime, scenario: WorkerScenario): Promise<Outcome> {
  const diagnostics: string[] = [];
  const started = performance.now();
  try {
    await scenario.run({ runtime, scratch, diagnostic: (line) => diagnostics.push(line) });
    return { ok: true, ms: performance.now() - started, diagnostics };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, ms: performance.now() - started, error: message.slice(0, 2_000), diagnostics };
  }
}

const rows: Row[] = [];
const runStarted = Date.now();
let exitCode = 0;
let invocations: InvocationTimes[] = [];

/** CPU per invocation as Cloudflare measured it (the in-isolate clock does not advance during CPU work). */
async function reportInvocationTimes() {
  // Workers Logs are ingested within seconds; give them a moment before reading.
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  invocations = await cloud.invocationTimes(runStarted);
  log("Cloudflare-measured time per invocation (Workers Logs), by worker spec, entrypoint and event:");
  log(
    `${"spec".padEnd(8)} ${"entrypoint/event".padEnd(36)} ${"n".padStart(6)} ${"cpu p50".padStart(8)} ${"cpu p95".padStart(8)} ${"cpu max".padStart(8)} ${"wall p50".padStart(9)} ${"wall max".padStart(9)}`,
  );
  for (const row of [...invocations].sort((a, b) =>
    `${a.spec}${a.entrypoint}${a.eventType}`.localeCompare(`${b.spec}${b.entrypoint}${b.eventType}`),
  ))
    log(
      `${row.spec.padEnd(8)} ${`${row.entrypoint}/${row.eventType}`.padEnd(36)} ${String(row.count).padStart(6)}${row.sampled ? "*" : " "}` +
        `${row.cpuMs.p50.toFixed(0).padStart(8)} ${row.cpuMs.p95.toFixed(0).padStart(8)} ${row.cpuMs.max.toFixed(0).padStart(8)} ${row.wallMs.p50.toFixed(0).padStart(9)} ${row.wallMs.max.toFixed(0).padStart(9)}`,
    );
  if (invocations.some((row) => row.sampled))
    log("  * log page limit reached for at least one worker: figures are from a sample");
}
try {
  for (const group of SCENARIO_GROUPS) {
    const scenarios = group.scenarios.filter((scenario) => !only || only.test(`${group.id}: ${scenario.name}`));
    if (!scenarios.length) continue;
    log(`== ${group.label} (${scenarios.length} scenarios)`);
    if (!args["skip-miniflare"]) {
      for (const scenario of scenarios) {
        const row: Row = { group: group.id, name: scenario.name };
        rows.push(row);
        row.miniflare = await attempt(local, scenario);
      }
      await local.dispose();
    }
    for (const scenario of scenarios) {
      let row = rows.find((candidate) => candidate.group === group.id && candidate.name === scenario.name);
      if (!row) rows.push((row = { group: group.id, name: scenario.name }));
      row.cloudflare = await attempt(cloud, scenario);
      const mark = (outcome?: Outcome) =>
        outcome ? `${outcome.ok ? "pass" : "FAIL"} ${outcome.ms.toFixed(0)}ms` : "-";
      log(`${mark(row.miniflare).padEnd(14)} | ${mark(row.cloudflare).padEnd(14)} | ${scenario.name}`);
      if (row.cloudflare.error) log(`    cloudflare: ${row.cloudflare.error.split("\n").slice(0, 6).join("\n    ")}`);
      if (row.miniflare?.error) log(`    miniflare: ${row.miniflare.error.split("\n").slice(0, 6).join("\n    ")}`);
      for (const line of row.miniflare?.diagnostics ?? []) log(`    miniflare diagnostic: ${line}`);
      for (const line of row.cloudflare.diagnostics) log(`    cloudflare diagnostic: ${line}`);
    }
  }
  await reportInvocationTimes().catch((error) => log(`invocation times unavailable: ${String(error)}`));
} catch (error) {
  log(`rehearsal aborted: ${error instanceof Error ? error.stack : String(error)}`);
  exitCode = 1;
} finally {
  const cleanupCode = await cleanup();
  exitCode ||= cleanupCode;
}

const differing = rows.filter((row) => row.miniflare && row.cloudflare && row.miniflare.ok !== row.cloudflare.ok);
const cloudFailures = rows.filter((row) => row.cloudflare && !row.cloudflare.ok);
log(
  `finished in ${((Date.now() - runStarted) / 1000).toFixed(0)} s: ${rows.length} scenarios, ` +
    `${rows.filter((row) => row.cloudflare?.ok).length} passed on Cloudflare, ${cloudFailures.length} failed; ` +
    `${differing.length} differ from Miniflare`,
);
for (const row of differing)
  log(
    `  DIFFERS ${row.group}: ${row.name} (miniflare ${row.miniflare!.ok ? "pass" : "fail"}, cloudflare ${row.cloudflare!.ok ? "pass" : "fail"})`,
  );
if (args.report) {
  await writeFile(
    args.report,
    JSON.stringify({ run: cloud.run, finishedAt: new Date().toISOString(), rows, invocations }, null, 2),
  );
  log(`report written to ${args.report}`);
}
process.exit(exitCode || (cloudFailures.length ? 1 : 0));
