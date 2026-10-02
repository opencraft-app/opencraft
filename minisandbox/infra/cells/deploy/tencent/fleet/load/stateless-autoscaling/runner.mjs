import { randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const RESPONSE_PADDING_BYTES = 64 << 10;
const STREAM_HEARTBEAT_MS = 15_000;

export function options(argv) {
	const result = {
		endpoint: "", output: "", runId: randomUUID().replaceAll("-", ""),
		durationMs: 900_000, holdMs: 450_000, rate: 2.5, maxInFlight: 1_500,
		requestTimeoutMs: 510_000,
	};
	const names = {
		"--endpoint": "endpoint", "--output": "output", "--run-id": "runId",
		"--duration-ms": "durationMs", "--hold-ms": "holdMs", "--rate": "rate",
		"--max-in-flight": "maxInFlight", "--request-timeout-ms": "requestTimeoutMs",
	};
	if (argv.length % 2 !== 0) throw new Error("arguments must be name/value pairs");
	for (let index = 0; index < argv.length; index += 2) {
		const field = names[argv[index]];
		if (!field) throw new Error(`unknown argument ${argv[index]}`);
		result[field] = typeof result[field] === "number" ? Number(argv[index + 1]) : argv[index + 1];
	}
	for (const [name, value] of Object.entries(result)) {
		if (typeof value !== "number") continue;
		const valid = name === "rate" ? Number.isFinite(value) && value > 0 : Number.isSafeInteger(value) && value >= 1;
		if (!valid) throw new Error(`${name} must be a positive ${name === "rate" ? "finite number" : "safe integer"}`);
	}
	if (result.holdMs >= result.requestTimeoutMs) throw new Error("request timeout must exceed hold time");
	if (result.maxInFlight < result.rate) throw new Error("max in-flight must be at least one second of arrivals");
	if (!/^[a-f0-9]{32}$/.test(result.runId)) throw new Error("run ID must be 32 lowercase hex characters");
	const endpoint = new URL(result.endpoint);
	if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search ||
		endpoint.hash || endpoint.pathname.replace(/\/$/, "") !== "/v1") {
		throw new Error("endpoint must be a credential-free public /v1 URL");
	}
	if (!result.output) throw new Error("output is required");
	result.endpoint = result.endpoint.replace(/\/$/, "");
	result.output = resolve(result.output);
	return result;
}

export function streamPlan(runId, holdMs) {
	// A non-trivial first chunk forces the HTTP stack to publish headers before
	// the delayed tail. Tiny streams may be coalesced until close, which would
	// incorrectly turn the Router's response-header timeout into the load limit.
	const response = JSON.stringify({ runId, bytes: runId.length, padding: "x".repeat(RESPONSE_PADDING_BYTES) });
	const split = Math.max(1, Math.floor(response.length / 2));
	const first = response.slice(0, split);
	const tail = response.slice(split);
	// Keep a real response body moving through every proxy while the executor
	// permit remains occupied. Without these heartbeats, the regional CLB's
	// idle-stream policy silently turns a twenty-minute hold into a five-minute
	// plateau and the HPA never sees the intended pressure.
	const heartbeatCount = Math.min(tail.length, Math.max(1, Math.ceil(holdMs / STREAM_HEARTBEAT_MS)));
	const chunks = [first];
	for (let index = 0; index < heartbeatCount; index++) {
		const start = Math.floor(index * tail.length / heartbeatCount);
		const end = Math.floor((index + 1) * tail.length / heartbeatCount);
		chunks.push(tail.slice(start, end));
	}
	return { response, chunks, intervalMs: Math.max(1, Math.floor(holdMs / heartbeatCount)) };
}

export function sourceFor(runId, holdMs) {
	const { response, chunks, intervalMs } = streamPlan(runId, holdMs);
	return `// Stateless autoscaling fixture ${runId}.
export default {
  fetch() {
	let timer;
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
		const chunks = ${JSON.stringify(chunks)};
		let index = 0;
		controller.enqueue(encoder.encode(chunks[index++]));
		timer = setInterval(() => {
		  controller.enqueue(encoder.encode(chunks[index++]));
		  if (index === chunks.length) {
		    clearInterval(timer);
		    controller.close();
		  }
		}, ${intervalMs});
	  },
	  cancel() { if (timer) clearInterval(timer); }
    });
    return new Response(stream, { headers: {
      "content-type": "application/json",
      "content-length": ${JSON.stringify(String(response.length))}
    } });
  }
};`;
}

async function jsonRequest(url, method, body, timeoutMs = 30_000) {
	const response = await fetch(url, {
		method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw Object.assign(new Error(`${method} ${url} returned ${response.status}: ${text.slice(0, 1024)}`), { status: response.status });
	return text ? JSON.parse(text) : null;
}

async function heldFetch(config, worker, index) {
	const began = performance.now();
	const response = await fetch(`${config.endpoint}/workers/${worker}/dispatch`, {
		method: "GET", redirect: "error",
		signal: AbortSignal.timeout(config.requestTimeoutMs),
		headers: {
			"x-workers-original-url": `https://stateless-scale.invalid/hold?request=${index}`,
		},
	});
	const text = await response.text();
	if (!response.ok) {
		let code = response.headers.get("x-rivet-overload-reason") || "Error";
		try {
			const value = JSON.parse(text);
			code = value?.error?.code || value?.code || code;
		} catch { /* a bounded status and generic code still preserve the failure */ }
		throw Object.assign(new Error(`dispatch returned ${response.status}: ${text.slice(0, 1024)}`), {
			status: response.status, code,
		});
	}
	const value = JSON.parse(text);
	if (value.runId !== config.runId || value.bytes !== config.runId.length) throw new Error("Worker response identity mismatch");
	return performance.now() - began;
}

export async function run(config) {
	await mkdir(config.output, { mode: 0o700 });
	const lock = await open(`${config.output}/run.lock`, "wx", 0o600);
	await lock.writeFile(`${process.pid}\n`);
	await lock.close();
	await writeFile(`${config.output}/config.json`, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });

	const worker = `stateless-scale-${config.runId.slice(0, 16)}`;
	const workerRoot = `${config.endpoint}/workers/${worker}`;
	const counters = { started: 0, completed: 0, failed: 0, peakInFlight: 0 };
	const errors = {};
	const durations = [];
	let versionId = null;
	let deploymentId = null;
	let workerDeleted = false;
	let fatalError = null;
	const startedAt = new Date().toISOString();
	const active = new Set();

	try {
		const version = await jsonRequest(`${workerRoot}/versions`, "POST", {
			main_module: "main.js", modules: { "main.js": sourceFor(config.runId, config.holdMs) },
			compatibility_date: "2026-08-14", durable_objects: {},
		});
		versionId = version?.id;
		if (!versionId) throw new Error("Version ID is absent");
		const deployment = await jsonRequest(`${workerRoot}/deployments`, "POST", { version_id: versionId });
		deploymentId = deployment?.id;
		if (!deploymentId) throw new Error("Deployment ID is absent");

		const began = performance.now();
		let nextAt = began;
		for (let index = 0; performance.now() - began < config.durationMs; index++) {
			while (active.size >= config.maxInFlight) await Promise.race(active);
			counters.started++;
			const promise = heldFetch(config, worker, index).then((duration) => {
				counters.completed++;
				durations.push(duration);
			}).catch((error) => {
				counters.failed++;
				const key = `${error.status ?? "transport"}:${error.code ?? error.name ?? "Error"}`;
				errors[key] = (errors[key] ?? 0) + 1;
			}).finally(() => active.delete(promise));
			active.add(promise);
			counters.peakInFlight = Math.max(counters.peakInFlight, active.size);
			nextAt += 1000 / config.rate;
			const delay = nextAt - performance.now();
			if (delay > 0) await sleep(delay);
		}
		await Promise.all(active);
	} catch (error) {
		fatalError = { name: error.name ?? "Error", status: error.status ?? null, message: String(error.message ?? error).slice(0, 1024) };
		const key = `setup:${error.status ?? "transport"}:${error.name ?? "Error"}`;
		errors[key] = (errors[key] ?? 0) + 1;
	} finally {
		try {
			const response = await fetch(workerRoot, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(30_000) });
			workerDeleted = response.status === 204;
			await response.arrayBuffer();
		} catch { workerDeleted = false; }
	}

	durations.sort((a, b) => a - b);
	const quantile = (q) => durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * q))] : null;
	const receipt = {
		schema: "actor-stateless-autoscaling-load/v1", runId: config.runId, worker,
		startedAt, finishedAt: new Date().toISOString(), versionId, deploymentId,
		config: {
			durationMs: config.durationMs, holdMs: config.holdMs, rate: config.rate,
			maxInFlight: config.maxInFlight, responsePaddingBytes: RESPONSE_PADDING_BYTES,
		},
		counters, errors, fatalError, workerDeleted,
		latencyMs: { p50: quantile(0.50), p95: quantile(0.95), p99: quantile(0.99), max: durations.at(-1) ?? null },
	};
	receipt.verdict = !fatalError && versionId && deploymentId && counters.started > 0 && counters.completed === counters.started &&
		counters.failed === 0 && workerDeleted ? "passed" : "failed";
	const temporary = `${config.output}/.receipt.json.tmp`;
	await writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	await rename(temporary, `${config.output}/receipt.json`);
	return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const config = options(process.argv.slice(2));
	const receipt = await run(config);
	console.log(JSON.stringify(receipt, null, 2));
	if (receipt.verdict !== "passed") process.exitCode = 1;
}
