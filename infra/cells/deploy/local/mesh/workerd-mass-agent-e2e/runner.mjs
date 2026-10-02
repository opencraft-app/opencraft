import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const [modulePath, endpoint, runId, mode, countText, concurrencyText, sampleText, arrivalRateText] =
  process.argv.slice(2);
const count = Number(countText);
const concurrency = Number(concurrencyText);
const sampleCount = Number(sampleText);
const arrivalRate = Number(arrivalRateText);
if (!modulePath || !endpoint || !runId || !["populate", "probe", "cleanup"].includes(mode)) {
  throw new Error("usage: runner.mjs MODULE ENDPOINT RUN_ID MODE COUNT CONCURRENCY SAMPLE_COUNT");
}
if (
  !Number.isSafeInteger(count) ||
  count < 1 ||
  !Number.isSafeInteger(concurrency) ||
  concurrency < 1 ||
  !Number.isFinite(arrivalRate) ||
  arrivalRate < 0
) {
  throw new Error("count and concurrency must be positive integers");
}

const { Miniflare } = await import(pathToFileURL(modulePath));
const worker = "mass-agent-e2e";
const className = "Agent";
const script = `
import { DurableObject } from "cloudflare:workers";

export class Agent extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.generation = env.RIVET_ACTOR.generation;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/state") {
      return Response.json({
        value: (await this.ctx.storage.get("value")) ?? 0,
        firstGeneration: (await this.ctx.storage.get("firstGeneration")) ?? 0,
        generation: this.generation,
      });
    }
    if (path !== "/initialize") return new Response("not found", { status: 404 });
    const token = request.headers.get("Idempotency-Key");
    if (!token || !/^[a-zA-Z0-9._:-]{1,128}$/.test(token)) {
      return Response.json({ error: "valid Idempotency-Key required" }, { status: 400 });
    }
    const operationKey = \`operation:\${token}\`;
    const replay = await this.ctx.storage.get(operationKey);
    if (replay !== undefined) {
      return Response.json({ value: replay, generation: this.generation, replayed: true });
    }
    const current = (await this.ctx.storage.get("value")) ?? 0;
    const value = current + 1;
    await this.ctx.storage.put({
      value,
      firstGeneration: (await this.ctx.storage.get("firstGeneration")) ?? this.generation,
      [operationKey]: value,
    });
    return Response.json({ value, generation: this.generation, replayed: false });
  }
}

export default { fetch() { return new Response("ready"); } };
`;

const mf = new Miniflare({
  endpoint,
  name: worker,
  script,
  compatibilityDate: "2026-08-14",
  durableObjects: { AGENT: className },
});

function objectName(index) {
  const shard = createHash("sha256").update(`${runId}:${index}`).digest("hex").slice(0, 16);
  return `mass-${shard}-${String(index).padStart(7, "0")}`;
}

function selectedIndices() {
  if (mode !== "probe") return Array.from({ length: count }, (_, index) => index);
  const wanted = Math.min(sampleCount, count);
  if (wanted === 1) return [0];
  return Array.from(
    new Set(
      Array.from({ length: wanted }, (_, index) =>
        Math.round((index * (count - 1)) / (wanted - 1)),
      ),
    ),
  );
}

function retryReason(error) {
  const status = Number.isSafeInteger(error?.status) ? String(error.status) : "network";
  const code =
    typeof error?.code === "string" && error.code.length > 0
      ? error.code
      : typeof error?.name === "string" && error.name.length > 0
        ? error.name
        : "unknown";
  return `${status}:${code}`;
}

async function requestWithRetry(operation, label, onRetry) {
  const deadline = Date.now() + 5 * 60_000;
  let attempt = 0;
  let last;
  while (Date.now() < deadline) {
    attempt++;
    try {
      return { value: await operation(), attempts: attempt };
    } catch (error) {
      last = error;
      if (error?.retryable === false || [400, 401, 403, 404, 409, 422].includes(error?.status)) {
        throw error;
      }
      onRetry(retryReason(error));
      const delay = Math.min(1000, 25 * 2 ** Math.min(attempt, 5));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`${label} did not converge: ${String(last)}`);
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

function unexpectedResponse(operation, index, response, body) {
  const error = new Error(
    `${operation} ${index} returned ${response.status}: ${JSON.stringify(body)}`,
  );
  error.status = response.status;
  error.code = response.ok ? `unexpected_${operation}_body` : `unexpected_${operation}_response`;
  error.retryable = response.ok || response.status >= 500;
  return error;
}

async function main() {
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace("AGENT");
  const indices = selectedIndices();
  const latencies = [];
  let retries = 0;
  const retryReasons = new Map();
  let completed = 0;
  let next = 0;
  const distribution = [0, 0];
  const started = performance.now();

  async function execute(index) {
    const stub = namespace.getByName(objectName(index));
    const cacheKey = `${worker}\0${className}\0${stub.id.toString()}`;
    distribution[createHash("sha256").update(cacheKey).digest()[0] % 2]++;
    const started = performance.now();
    let result;
    const recordRetry = (reason) => retryReasons.set(reason, (retryReasons.get(reason) ?? 0) + 1);
    if (mode === "populate") {
      result = await requestWithRetry(async () => {
        const response = await stub.fetch("https://agent.example/initialize", {
          method: "POST",
          headers: { "Idempotency-Key": `${runId}:${index}` },
        });
        const body = await response.json();
        if (!response.ok || body.value !== 1) {
          throw unexpectedResponse("initialize", index, response, body);
        }
        return body;
      }, `initialize ${index}`, recordRetry);
    } else if (mode === "probe") {
      result = await requestWithRetry(async () => {
        const response = await stub.fetch("https://agent.example/state");
        const body = await response.json();
        if (
          !response.ok ||
          body.value !== 1 ||
          !Number.isInteger(body.firstGeneration) ||
          body.generation <= body.firstGeneration
        ) {
          throw unexpectedResponse("probe", index, response, body);
        }
        return body;
      }, `probe ${index}`, recordRetry);
    } else {
      result = await requestWithRetry(async () => {
        await stub.delete();
        return { deleted: true };
      }, `delete ${index}`, recordRetry);
    }
    retries += result.attempts - 1;
    latencies.push(performance.now() - started);
    completed++;
    const interval = Math.max(1, Math.floor(indices.length / 20));
    if (completed % interval === 0 || completed === indices.length) {
      console.error(`${mode} ${completed}/${indices.length}`);
    }
  }

  async function workerLoop() {
    while (true) {
      const position = next++;
      if (position >= indices.length) return;
      if (mode === "populate" && arrivalRate > 0) {
        const target = started + (position * 1000) / arrivalRate;
        const delay = target - performance.now();
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      await execute(indices[position]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, indices.length) }, () => workerLoop()),
  );
  console.log(
    JSON.stringify({
      mode,
      worker,
      class_name: className,
      run_id: runId,
      target_count: count,
      operated_count: indices.length,
      concurrency,
      requested_arrival_rate_per_second: mode === "populate" ? arrivalRate : 0,
      retries,
      retry_reasons: Object.fromEntries([...retryReasons.entries()].sort()),
      duration_ms: performance.now() - started,
      throughput_per_second: indices.length / ((performance.now() - started) / 1000),
      latency_ms: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        max: Math.max(...latencies),
      },
      cell_distribution: { "local-runtime-a": distribution[0], "local-runtime-b": distribution[1] },
    }),
  );
}

try {
  await main();
} finally {
  await mf.dispose();
}
