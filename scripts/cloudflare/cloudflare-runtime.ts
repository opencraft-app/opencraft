// Real-Cloudflare implementation of the scenario WorkerRuntime
// (tests/cloudflare/worker-runtime.ts), used only by `npm run cf:rehearsal`.
//
// Every worker and R2 bucket it creates is named `opencraft-rehearsal-<run>…`
// and recorded; `cleanup()` deletes exactly those names and nothing else.
// Uploads go straight to the Cloudflare REST API (multipart module upload with
// metadata), so no wrangler dependency is needed.
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  bufferedSocket,
  bundleWorker,
  COMPATIBILITY_DATE,
  type BindingValue,
  type StartOptions,
  type WorkerBundle,
  type WorkerInstance,
  type WorkerRuntime,
  type WorkerSpec,
  type WorkerUpgrade,
} from "../../tests/cloudflare/worker-runtime.ts";
import {
  REHEARSAL_HEALTH_PATH,
  REHEARSAL_KEY_HEADER,
  REHEARSAL_PURGE_PATH,
  REHEARSAL_URL_HEADER,
} from "./rehearsal-guard.ts";

export const REHEARSAL_PREFIX = "opencraft-rehearsal-";
const API = "https://api.cloudflare.com/client/v4";
const GUARD_MODULE = new URL("./rehearsal-guard.ts", import.meta.url).pathname;
const RESOURCE_NAME = /^opencraft-rehearsal-[0-9a-f]{8}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/u;

export interface AccountResource { readonly name: string; readonly changedAt: number }

interface ApiEnvelope<T> { success: boolean; result: T; errors?: { code: number; message: string }[]; result_info?: { cursor?: string } }

export class CloudflareApi {
  constructor(readonly accountId: string, readonly token: string) {}
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${this.token}` } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${API}/accounts/${this.accountId}${path}`, init);
      const text = await response.text();
      let envelope: ApiEnvelope<T> | undefined;
      try { envelope = JSON.parse(text) as ApiEnvelope<T>; } catch { /* not JSON */ }
      if (response.ok && envelope?.success) return envelope.result;
      // Retry rate limits and transient edge failures a few times.
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
        continue;
      }
      const errors = envelope?.errors?.map((error) => `${error.code} ${error.message}`).join("; ") || text.slice(0, 300);
      throw Object.assign(new Error(`Cloudflare API ${method} ${path} → HTTP ${response.status}: ${errors}`), { status: response.status });
    }
  }
  async listWorkers(): Promise<string[]> {
    return (await this.listWorkerDetails()).map((script) => script.name);
  }
  async listBuckets(): Promise<string[]> {
    return (await this.listBucketDetails()).map((bucket) => bucket.name);
  }
  /** Names with their last change (workers: modified_on; buckets: creation_date), sorted by name. */
  async listWorkerDetails(): Promise<AccountResource[]> {
    const scripts = await this.call<{ id: string; modified_on?: string; created_on?: string }[]>("GET", "/workers/scripts");
    return scripts.map((script) => ({ name: script.id, changedAt: Date.parse(script.modified_on ?? script.created_on ?? "") || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async listBucketDetails(): Promise<AccountResource[]> {
    const { buckets } = await this.call<{ buckets: { name: string; creation_date?: string }[] }>("GET", "/r2/buckets");
    return buckets.map((bucket) => ({ name: bucket.name, changedAt: Date.parse(bucket.creation_date ?? "") || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async subdomain(): Promise<string> {
    return (await this.call<{ subdomain: string }>("GET", "/workers/subdomain")).subdomain;
  }
}

export interface InvocationTimes {
  /** Worker spec id; figures are pooled over every worker of that spec. */
  readonly spec: string;
  /** `fetch` for the edge worker, the Durable Object class for DO events (RPC, fetch, alarm, socket). */
  readonly entrypoint: string;
  readonly eventType: string;
  readonly count: number;
  readonly cpuMs: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly wallMs: { readonly p50: number; readonly max: number };
  /** True when the log page limit was reached, so the figures are a sample. */
  readonly sampled: boolean;
}

interface TelemetryEvent { $workers?: { entrypoint?: string; eventType?: string; cpuTimeMs?: number; wallTimeMs?: number } }
const LOG_PAGE = 2_000;
/** Extra wait after an `immediate` redeploy before the restarted runtime is used. */
const RESTART_SETTLE_MS = 5_000;

interface Deployment {
  readonly name: string;
  readonly spec: WorkerSpec;
  readonly origin: string;
  generation: number;
  migrated: boolean;
}

export interface CloudflareRuntimeOptions {
  readonly api: CloudflareApi;
  readonly log: (line: string) => void;
  /** Names that existed before the run; never created, changed or deleted. */
  readonly existingWorkers: readonly string[];
  readonly existingBuckets: readonly string[];
}

export interface CloudflareRuntime extends WorkerRuntime {
  readonly run: string;
  readonly created: { readonly workers: ReadonlySet<string>; readonly buckets: ReadonlySet<string> };
  /** Deletes every worker and bucket this run created. Returns what could not be deleted. */
  cleanup(): Promise<string[]>;
  /** Per-invocation CPU and wall time from Workers Logs for every worker this run deployed. */
  invocationTimes(since: number): Promise<InvocationTimes[]>;
}

export async function cloudflareRuntime(options: CloudflareRuntimeOptions): Promise<CloudflareRuntime> {
  const { api, log } = options;
  const run = randomBytes(4).toString("hex");
  const prefix = `${REHEARSAL_PREFIX}${run}`;
  // Per-run access key: only in this process's memory and the worker's secret binding.
  const key = randomBytes(32).toString("base64url");
  const subdomain = await api.subdomain();
  const workers = new Set<string>();
  const buckets = new Set<string>();
  const bundles = new Map<string, Promise<WorkerBundle>>();
  const persisted = new Map<string, Deployment>();
  const deployments = new Map<WorkerInstance, Deployment>();
  /** Every worker name this run deployed, with its spec id, for the invocation report. */
  const deployed = new Map<string, string>();
  const sockets = new Map<string, Set<WebSocket>>();
  let serial = 0;
  /** Set once cleanup starts: nothing new may be created after that. */
  let closed = false;

  const assertOwned = (name: string) => {
    if (!RESOURCE_NAME.test(name) || !name.startsWith(prefix)) throw new Error(`Refusing to touch ${name}: not a resource of rehearsal ${prefix}`);
    if (options.existingWorkers.includes(name) || options.existingBuckets.includes(name)) throw new Error(`Refusing to touch pre-existing ${name}`);
  };

  async function bucketFor(binding: string): Promise<string> {
    if (closed) throw new Error("rehearsal is cleaning up; not creating buckets");
    const name = `${prefix}-${binding.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
    if (buckets.has(name)) return name;
    assertOwned(name);
    buckets.add(name);
    await api.call("POST", "/r2/buckets", { name });
    log(`created R2 bucket ${name}`);
    return name;
  }

  function bindingsFor(deployment: Deployment, vars: Readonly<Record<string, BindingValue>>, r2: Record<string, string>) {
    const bindings: Record<string, unknown>[] = [
      ...Object.entries(deployment.spec.durableObjects).map(([name, className]) => ({ type: "durable_object_namespace", name, class_name: className })),
      ...Object.entries(r2).map(([name, bucket]) => ({ type: "r2_bucket", name, bucket_name: bucket })),
      { type: "secret_text", name: "REHEARSAL_KEY", text: key },
      { type: "plain_text", name: "REHEARSAL_GENERATION", text: String(deployment.generation) },
      { type: "json", name: "REHEARSAL_R2", json: Object.keys(r2) },
    ];
    // Strings stay strings and numbers stay numbers, as Miniflare `bindings` give them.
    for (const [name, value] of Object.entries(vars))
      bindings.push(typeof value === "string" ? { type: "plain_text", name, text: value } : { type: "json", name, json: value });
    return bindings;
  }

  async function deploy(deployment: Deployment, vars: Readonly<Record<string, BindingValue>>) {
    if (closed) throw new Error("rehearsal is cleaning up; not deploying");
    assertOwned(deployment.name);
    const { code } = await runtime.bundle(deployment.spec);
    const r2: Record<string, string> = {};
    for (const binding of deployment.spec.r2Buckets ?? []) r2[binding] = await bucketFor(binding);
    const metadata: Record<string, unknown> = {
      main_module: "worker.mjs",
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: [...(deployment.spec.compatibilityFlags ?? [])],
      bindings: bindingsFor(deployment, vars, r2),
      // Workers Logs record per-invocation CPU and wall time (see invocationTimes()).
      observability: { enabled: true, head_sampling_rate: 1 },
      // The Durable Object classes are created by the first version only.
      ...(deployment.migrated ? {} : { migrations: { new_tag: "v1", new_sqlite_classes: [...new Set(Object.values(deployment.spec.durableObjects))] } }),
    };
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.set("worker.mjs", new Blob([code], { type: "application/javascript+module" }), "worker.mjs");
    const first = !deployment.migrated;
    if (first) { workers.add(deployment.name); deployed.set(deployment.name, deployment.spec.id); }
    const started = Date.now();
    await api.call("PUT", `/workers/scripts/${deployment.name}`, form);
    // An upload that finished after cleanup started is removed here.
    if (closed) { await deleteWorker(deployment.name); throw new Error("rehearsal is cleaning up; deleted the late upload"); }
    deployment.migrated = true;
    if (!first) {
      // A restart must reach Durable Objects that are still active. The upload's implicit
      // deployment uses the default `deferred` code update strategy (an active object keeps
      // its old code and in-memory state for up to 300 s), so deploy the same version again
      // with `immediate`, as a migration-bearing production deploy would have to.
      const { deployments } = await api.call<{ deployments: { versions: { version_id: string }[] }[] }>("GET", `/workers/scripts/${deployment.name}/deployments`);
      const version = deployments[0]?.versions[0]?.version_id;
      if (!version) throw new Error(`${deployment.name}: no current version after upload`);
      await api.call("POST", `/workers/scripts/${deployment.name}/deployments`, {
        strategy: "percentage",
        versions: [{ version_id: version, percentage: 100 }],
        code_update_strategy: { mode: "immediate" },
      });
    }
    if (first) await api.call("POST", `/workers/scripts/${deployment.name}/subdomain`, { enabled: true, previews_enabled: false });
    // Wait until the edge serves this generation.
    const deadline = Date.now() + 90_000;
    let consecutive = 0;
    for (;;) {
      try {
        const response = await fetch(deployment.origin + REHEARSAL_HEALTH_PATH, { headers: { [REHEARSAL_KEY_HEADER]: key } });
        const body = response.ok ? await response.json() as { generation: string | null } : await response.text().then(() => null);
        consecutive = body?.generation === String(deployment.generation) ? consecutive + 1 : 0;
        if (consecutive >= 3) break;
      } catch { consecutive = 0; }
      if (Date.now() > deadline) throw new Error(`${deployment.name} generation ${deployment.generation} did not become reachable`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // The edge serving the new generation does not mean every active object has reset yet;
    // the probe in the docs measured about 1 s more. No prototype exposes its version, so settle.
    if (!first) await new Promise((resolve) => setTimeout(resolve, RESTART_SETTLE_MS));
    log(`${first ? "deployed" : "redeployed"} ${deployment.name} (generation ${deployment.generation}) in ${Date.now() - started} ms`);
  }

  function target(deployment: Deployment, url: string) {
    const virtual = new URL(url);
    return { url: `${deployment.origin}${virtual.pathname}${virtual.search}`, virtual: virtual.href };
  }

  const runtime: CloudflareRuntime = {
    kind: "cloudflare",
    label: "Cloudflare",
    patience: 4,
    run: prefix,
    created: { workers, buckets },
    bundle(spec) {
      let bundle = bundles.get(spec.id);
      if (!bundle) bundles.set(spec.id, (bundle = bundleWorker(spec, { module: GUARD_MODULE, exportName: "rehearsalGuard" })));
      return bundle;
    },
    async start(spec, startOptions: StartOptions = {}) {
      let deployment = startOptions.persist ? persisted.get(startOptions.persist) : undefined;
      if (deployment) deployment.generation++;
      else {
        const name = `${prefix}-${spec.id}-${++serial}`;
        if (name.length > 63) throw new Error(`Worker name too long: ${name}`);
        deployment = { name, spec, origin: `https://${name}.${subdomain}.workers.dev`, generation: 1, migrated: false };
        if (startOptions.persist) persisted.set(startOptions.persist, deployment);
      }
      if (deployment.spec.entry !== spec.entry) throw new Error(`persist key ${startOptions.persist} is bound to ${deployment.spec.id}`);
      const vars = typeof startOptions.vars === "function" ? startOptions.vars(deployment.origin) : (startOptions.vars ?? {});
      await deploy(deployment, vars);
      const current = deployment;
      const instance: WorkerInstance = {
        origin: current.origin,
        async fetch(url, init = {}) {
          const { url: address, virtual } = target(current, url);
          const headers = new Headers(init.headers);
          headers.set(REHEARSAL_KEY_HEADER, key);
          headers.set(REHEARSAL_URL_HEADER, virtual);
          return fetch(address, { ...init, headers, redirect: init.redirect ?? "manual" });
        },
        upgrade(url, headers = {}) {
          const { url: address, virtual } = target(current, url);
          const { "sec-websocket-protocol": protocol, ...rest } = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
          return new Promise<WorkerUpgrade>((resolve, reject) => {
            const socket = new WebSocket(address.replace(/^https:/u, "wss:"), protocol ? protocol.split(/,\s*/u) : [], {
              headers: { ...rest, [REHEARSAL_KEY_HEADER]: key, [REHEARSAL_URL_HEADER]: virtual },
              perMessageDeflate: false,
              handshakeTimeout: 30_000,
            });
            socket.binaryType = "arraybuffer";
            let open = sockets.get(current.name);
            if (!open) sockets.set(current.name, (open = new Set()));
            open.add(socket);
            socket.on("close", () => open.delete(socket));
            socket.once("open", () => resolve({ status: 101, socket: bufferedSocket(socket as never) }));
            socket.once("unexpected-response", (request, response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("end", () => {
                resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
                request.destroy();
                open.delete(socket);
              });
            });
            socket.once("error", (error) => { open.delete(socket); reject(error); });
          });
        },
      };
      deployments.set(instance, current);
      return instance;
    },
    async stop(instance) {
      const deployment = deployments.get(instance);
      deployments.delete(instance);
      if (!deployment) return;
      for (const socket of sockets.get(deployment.name) ?? []) socket.terminate();
      // Fresh-storage deployments are deleted right away; persisted ones wait for their restart.
      if (![...persisted.values()].includes(deployment) && ![...deployments.values()].includes(deployment)) await deleteWorker(deployment.name);
    },
    async invocationTimes(since) {
      const rows: InvocationTimes[] = [];
      const quantile = (values: number[], q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
      const groups = new Map<string, { spec: string; entrypoint: string; eventType: string; cpu: number[]; wall: number[]; sampled: boolean }>();
      for (const [worker, spec] of deployed) {
        const result = await api.call<{ events?: { events?: TelemetryEvent[] } }>("POST", "/workers/observability/telemetry/query", {
          queryId: `rehearsal-${run}`,
          timeframe: { from: since - 60_000, to: Date.now() + 60_000 },
          view: "events",
          limit: LOG_PAGE,
          parameters: { filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: worker }] },
        });
        const events = result.events?.events ?? [];
        for (const event of events) {
          const fields = event.$workers;
          if (typeof fields?.cpuTimeMs !== "number") continue;
          const entrypoint = fields.entrypoint ?? "fetch", eventType = fields.eventType ?? "unknown";
          const id = `${spec}/${entrypoint}/${eventType}`;
          let group = groups.get(id);
          if (!group) groups.set(id, (group = { spec, entrypoint, eventType, cpu: [], wall: [], sampled: false }));
          group.cpu.push(fields.cpuTimeMs);
          group.wall.push(fields.wallTimeMs ?? 0);
          group.sampled ||= events.length >= LOG_PAGE;
        }
      }
      for (const group of groups.values()) {
        group.cpu.sort((a, b) => a - b);
        group.wall.sort((a, b) => a - b);
        rows.push({
          spec: group.spec, entrypoint: group.entrypoint, eventType: group.eventType, count: group.cpu.length,
          cpuMs: { p50: quantile(group.cpu, 0.5), p95: quantile(group.cpu, 0.95), max: group.cpu.at(-1)! },
          wallMs: { p50: quantile(group.wall, 0.5), max: group.wall.at(-1)! },
          sampled: group.sampled,
        });
      }
      return rows;
    },
    async cleanup() {
      closed = true;
      const failures: string[] = [];
      for (const set of sockets.values()) for (const socket of set) socket.terminate();
      // Empty the buckets through a live worker that binds them, then delete everything.
      for (const deployment of new Set([...persisted.values(), ...deployments.values()])) {
        if (!deployment.spec.r2Buckets?.length || !workers.has(deployment.name)) continue;
        try {
          const response = await fetch(deployment.origin + REHEARSAL_PURGE_PATH, { method: "POST", headers: { [REHEARSAL_KEY_HEADER]: key } });
          log(`purged R2 through ${deployment.name}: ${await response.text()}`);
        } catch (error) { log(`R2 purge through ${deployment.name} failed: ${String(error)}`); }
      }
      for (const name of [...workers]) {
        try { await deleteWorker(name); } catch (error) { failures.push(`worker ${name}: ${String(error)}`); }
      }
      for (const name of [...buckets]) {
        try {
          assertOwned(name);
          try {
            await api.call("DELETE", `/r2/buckets/${name}`);
          } catch {
            // No live worker emptied it (its binding worker was already deleted): purge and retry.
            const { purgeBuckets } = await import("./rehearsal-leftovers.ts");
            await purgeBuckets(api, [name], log);
            await api.call("DELETE", `/r2/buckets/${name}`);
          }
          buckets.delete(name);
          log(`deleted R2 bucket ${name}`);
        } catch (error) { failures.push(`bucket ${name}: ${String(error)}`); }
      }
      return failures;
    },
  };

  async function deleteWorker(name: string) {
    if (!workers.has(name)) return;
    assertOwned(name);
    try {
      // force=true also deletes the worker's Durable Object namespaces and their storage.
      await api.call("DELETE", `/workers/scripts/${name}?force=true`);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    workers.delete(name);
    log(`deleted worker ${name}`);
  }

  return runtime;
}
