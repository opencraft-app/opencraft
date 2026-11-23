// Finds and deletes what an earlier `npm run cf:rehearsal` left behind (a run
// killed with SIGKILL, a crashed machine, `--keep`). Only resources whose exact
// name matches the rehearsal naming scheme are ever touched:
//   opencraft-rehearsal-<8 hex run id>[-<suffix>]
// A run counts as stale when none of its resources changed in the last
// `staleMinutes`, so a rehearsal still running from another shell is left alone.
// R2 buckets must be empty before deletion; leftover objects are removed through
// a short-lived purge worker (rehearsal guard + empty worker) that binds them.
import { randomBytes } from "node:crypto";
import { bundleWorker, COMPATIBILITY_DATE } from "../../tests/cloudflare/worker-runtime.ts";
import { type AccountResource, type CloudflareApi, REHEARSAL_PREFIX } from "./cloudflare-runtime.ts";
import { REHEARSAL_HEALTH_PATH, REHEARSAL_KEY_HEADER, REHEARSAL_PURGE_PATH } from "./rehearsal-guard.ts";

const LEFTOVER_NAME = /^opencraft-rehearsal-([0-9a-f]{8})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/u;
const PURGE_ENTRY = new URL("./purge-worker.ts", import.meta.url).pathname;
const GUARD_MODULE = new URL("./rehearsal-guard.ts", import.meta.url).pathname;

export interface LeftoverReport {
  readonly deletedWorkers: string[];
  readonly deletedBuckets: string[];
  /** Resources of runs that changed recently; left alone. */
  readonly recent: string[];
  readonly failures: string[];
}

export async function cleanLeftovers(api: CloudflareApi, options: { staleMinutes: number; log: (line: string) => void }): Promise<LeftoverReport> {
  const { log } = options;
  const report: LeftoverReport = { deletedWorkers: [], deletedBuckets: [], recent: [], failures: [] };
  const workers = (await api.listWorkerDetails()).filter((resource) => LEFTOVER_NAME.test(resource.name));
  const buckets = (await api.listBucketDetails()).filter((resource) => LEFTOVER_NAME.test(resource.name));
  if (!workers.length && !buckets.length) return report;

  // Group by run id; a run is stale only when all of its resources are old.
  const runOf = (resource: AccountResource) => LEFTOVER_NAME.exec(resource.name)![1]!;
  const lastChange = new Map<string, number>();
  for (const resource of [...workers, ...buckets]) lastChange.set(runOf(resource), Math.max(lastChange.get(runOf(resource)) ?? 0, resource.changedAt));
  const cutoff = Date.now() - options.staleMinutes * 60_000;
  const stale = (resource: AccountResource) => (lastChange.get(runOf(resource)) ?? 0) <= cutoff;
  for (const resource of [...workers, ...buckets].filter((candidate) => !stale(candidate))) report.recent.push(resource.name);
  if (report.recent.length) log(`leaving resources of a rehearsal changed in the last ${options.staleMinutes} min: ${report.recent.join(", ")}`);

  for (const { name } of workers.filter(stale)) {
    try {
      // force=true also deletes the worker's Durable Object namespaces and their storage.
      await api.call("DELETE", `/workers/scripts/${name}?force=true`);
      report.deletedWorkers.push(name);
      log(`deleted leftover worker ${name}`);
    } catch (error) {
      if ((error as { status?: number }).status === 404) continue;
      report.failures.push(`worker ${name}: ${String(error)}`);
    }
  }

  const staleBuckets = buckets.filter(stale).map((bucket) => bucket.name);
  const nonEmpty: string[] = [];
  for (const name of staleBuckets) {
    try {
      await api.call("DELETE", `/r2/buckets/${name}`);
      report.deletedBuckets.push(name);
      log(`deleted leftover R2 bucket ${name}`);
    } catch {
      nonEmpty.push(name);
    }
  }
  if (nonEmpty.length) {
    try {
      await purgeBuckets(api, nonEmpty, log);
    } catch (error) {
      report.failures.push(`purging ${nonEmpty.join(", ")}: ${String(error)}`);
    }
    for (const name of nonEmpty) {
      try {
        await api.call("DELETE", `/r2/buckets/${name}`);
        report.deletedBuckets.push(name);
        log(`deleted leftover R2 bucket ${name} after emptying it`);
      } catch (error) {
        report.failures.push(`bucket ${name}: ${String(error)}`);
      }
    }
  }
  return report;
}

/** Empties `buckets` through a temporary guarded worker that binds them, then deletes the worker. */
export async function purgeBuckets(api: CloudflareApi, buckets: readonly string[], log: (line: string) => void): Promise<void> {
  const name = `${REHEARSAL_PREFIX}${randomBytes(4).toString("hex")}-purge`;
  if (!LEFTOVER_NAME.test(name)) throw new Error(`unexpected purge worker name ${name}`);
  const key = randomBytes(32).toString("base64url");
  const bindingNames = buckets.map((_, index) => `LEFTOVER_${index}`);
  const { code } = await bundleWorker({ id: "purge", entry: PURGE_ENTRY, durableObjects: {} }, { module: GUARD_MODULE, exportName: "rehearsalGuard" });
  const metadata = {
    main_module: "worker.mjs",
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      ...buckets.map((bucket, index) => ({ type: "r2_bucket", name: bindingNames[index], bucket_name: bucket })),
      { type: "secret_text", name: "REHEARSAL_KEY", text: key },
      { type: "plain_text", name: "REHEARSAL_GENERATION", text: "1" },
      { type: "json", name: "REHEARSAL_R2", json: bindingNames },
    ],
  };
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.set("worker.mjs", new Blob([code], { type: "application/javascript+module" }), "worker.mjs");
  await api.call("PUT", `/workers/scripts/${name}`, form);
  try {
    await api.call("POST", `/workers/scripts/${name}/subdomain`, { enabled: true, previews_enabled: false });
    const origin = `https://${name}.${await api.subdomain()}.workers.dev`;
    const deadline = Date.now() + 90_000;
    for (;;) {
      const ok = await fetch(origin + REHEARSAL_HEALTH_PATH, { headers: { [REHEARSAL_KEY_HEADER]: key } }).then((response) => response.ok, () => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error(`purge worker ${name} did not become reachable`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const response = await fetch(origin + REHEARSAL_PURGE_PATH, { method: "POST", headers: { [REHEARSAL_KEY_HEADER]: key } });
    log(`emptied leftover R2 buckets ${buckets.join(", ")} through ${name}: ${await response.text()}`);
  } finally {
    await api.call("DELETE", `/workers/scripts/${name}?force=true`).catch((error) => log(`could not delete purge worker ${name}: ${String(error)}`));
  }
}
