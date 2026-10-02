import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export function options(argv) {
	const result = {
		endpoint: "", output: "", count: 200000, rate: 20, active: 1000, workers: 16,
		warmup: 1600, warmupRate: 2, warmupSettleMs: 120000,
		warmupBackpressureTimeoutMs: 900000,
		activeIntervalMs: 10000, observeAfterMs: 300000, timeoutMs: 15000,
		maxInFlight: 2048, maxConsecutiveFailures: 100, retries: 3,
		readySloMs: 3000, runId: randomUUID().replaceAll("-", ""),
	};
	const names = {
		"--endpoint": "endpoint", "--output": "output", "--count": "count",
		"--rate": "rate", "--active": "active", "--workers": "workers",
		"--warmup": "warmup", "--warmup-rate": "warmupRate", "--warmup-settle-ms": "warmupSettleMs",
		"--warmup-backpressure-timeout-ms": "warmupBackpressureTimeoutMs",
		"--active-interval-ms": "activeIntervalMs", "--observe-after-ms": "observeAfterMs",
		"--timeout-ms": "timeoutMs", "--max-in-flight": "maxInFlight",
		"--max-consecutive-failures": "maxConsecutiveFailures", "--retries": "retries",
		"--ready-slo-ms": "readySloMs", "--run-id": "runId",
	};
	for (let position = 0; position < argv.length; position += 2) {
		const name = names[argv[position]];
		if (!name || argv[position + 1] === undefined) throw new Error("invalid arguments");
		result[name] = typeof result[name] === "number" ? Number(argv[position + 1]) : argv[position + 1];
	}
	for (const [name, value] of Object.entries(result)) {
		if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1)) {
			throw new Error(`${name} must be a positive safe integer`);
		}
	}
	if (result.active > result.count) throw new Error("active must not exceed count");
	if (result.active > result.warmup || result.warmup > result.count) throw new Error("warmup must be between active and count");
	if (result.workers > result.count) throw new Error("workers must not exceed count");
	const url = new URL(result.endpoint);
	if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") {
		throw new Error("endpoint must be a credential-free public /v1 URL");
	}
	if (!result.output || !/^[a-f0-9]{32}$/.test(result.runId)) throw new Error("output and a 32-hex run ID are required");
	result.endpoint = result.endpoint.replace(/\/$/, "");
	result.output = resolve(result.output);
	return result;
}

export function identity(runId, index, workers) {
	const shard = index % workers;
	return {
		worker: `scale-${runId}-s${String(shard).padStart(3, "0")}`,
		objectId: createHash("sha256").update(`${runId}\0${index}`).digest("hex"),
		shard,
	};
}

export function sourceFor(runId, shard) {
	return `// Shared Agent scale fixture ${runId}:${shard}.
import { DurableObject } from "cloudflare:workers";
export class Agent extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/state") {
      return Response.json((await this.ctx.storage.get("state")) ?? null);
    }
    const message = await request.json();
    if (message.runId !== ${JSON.stringify(runId)} || message.shard !== ${shard} ||
        !Number.isInteger(message.agent) || typeof message.operation !== "string") {
      return new Response("invalid message", { status: 400 });
    }
    const operationKey = "operation:" + message.operation;
    const replay = await this.ctx.storage.get(operationKey);
    if (replay !== undefined) return Response.json(replay);
    const state = (await this.ctx.storage.get("state")) ?? { initialized: false, heartbeats: 0 };
    if (message.operation === "init") state.initialized = true;
    else state.heartbeats++;
    state.agent = message.agent;
    state.lastOperation = message.operation;
    const response = { runId: message.runId, agent: message.agent, operation: message.operation,
      initialized: state.initialized, heartbeats: state.heartbeats };
    await this.ctx.storage.put({ state, [operationKey]: response });
    return Response.json(response);
  }
}
export default { fetch() { return new Response("ready"); } };`;
}

export function qualificationPassed(result) {
	return !result.stopReason && result.counters.objectsCreated === result.target &&
		result.counters.objectsFailed === 0 && result.counters.readySloBreaches === 0 &&
		result.counters.requestRetries === 0 && result.counters.activeFailed === 0 &&
		(result.counters.warmupBackpressureTimeouts ?? 0) === 0 &&
		result.activeReady === result.activeTarget &&
		result.activeProven === result.activeTarget && result.counters.activeIdentityMismatches === 0;
}

class Histogram {
	constructor() { this.bins = new Array(256).fill(0); this.count = 0; this.max = 0; }
	add(value) {
		this.bins[Math.min(255, Math.ceil(Math.log2(Math.max(1, value)) * 8))]++;
		this.count++; this.max = Math.max(this.max, value);
	}
	quantile(q) {
		let accumulated = 0;
		for (let index = 0; index < this.bins.length; index++) {
			accumulated += this.bins[index];
			if (this.count && accumulated >= Math.ceil(this.count * q)) return 2 ** (index / 8);
		}
		return null;
	}
	json() { return { count: this.count, p50UpperBoundMs: this.quantile(0.5), p95UpperBoundMs: this.quantile(0.95), p99UpperBoundMs: this.quantile(0.99), maxMs: this.max }; }
}

export async function run(config) {
	await mkdir(config.output, { recursive: true, mode: 0o700 });
	const lock = await open(`${config.output}/run.lock`, "wx", 0o600);
	await lock.writeFile(`${process.pid}\n`); await lock.close();
	await writeFile(`${config.output}/config.json`, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	const journal = await open(`${config.output}/events.ndjson`, "ax", 0o600);
	const counters = {
		versionsPublished: 0, deploymentsPublished: 0, scheduled: 0, createAttempts: 0,
		objectsCreated: 0, objectsFailed: 0, readySloBreaches: 0, requestRetries: 0,
		warmupBackpressureRetries: 0, warmupBackpressureTimeouts: 0,
		activeTargetReady: 0, activeAttempts: 0, activeSucceeded: 0, activeFailed: 0,
		activeIdentityMismatches: 0, consecutiveCreationFailures: 0, inFlightPeak: 0,
	};
	const errors = {};
	const warmupBackpressureObjects = new Set();
	const phases = Object.fromEntries(["version", "deployment", "create", "initialize", "warmupReady", "ready", "active"].map((name) => [name, new Histogram()]));
	const inFlight = new Set();
	const activeInFlight = new Set();
	const heartbeatReady = new Set();
	const activeReady = new Set();
	const activeProven = new Set();
	const activeSequence = new Uint32Array(config.warmup);
	const began = performance.now();
	const startedAt = new Date().toISOString();
	let stopping = false;
	let stopReason = null;
	let journalFailure = null;
	let journalTail = Promise.resolve();
	const controller = new AbortController();

	function log(value) {
		journalTail = journalTail.then(() => journal.write(JSON.stringify(value) + "\n")).catch((error) => {
			journalFailure = error; stopping = true; stopReason = "journal_failure"; controller.abort();
		});
	}
	function recordError(phase, error, index) {
		const key = `${phase}:${error.status ?? "network"}:${error.code ?? "transport"}`;
		const bounded = Object.keys(errors).length < 128 || errors[key] !== undefined ? key : "other";
		errors[bounded] = (errors[bounded] ?? 0) + 1;
		log({ event: "error", at: new Date().toISOString(), index, phase, status: error.status, code: error.code ?? "transport" });
	}
	async function request(phase, method, route, body, index, originalPath = "/messages") {
		const start = performance.now();
		try {
			const response = await fetch(config.endpoint + route, {
				method, redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs)]),
				headers: { "content-type": "application/json", "x-workers-original-url": `https://agent.example${originalPath}` },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await response.text();
			if (text.length > 65536) throw Object.assign(new Error("oversized response"), { code: "oversized_response" });
			const value = text ? JSON.parse(text) : null;
			if (!response.ok) throw Object.assign(new Error("HTTP request failed"), { status: response.status, code: value?.error?.code ?? "http_error" });
			return value;
		} finally { phases[phase].add(performance.now() - start); }
	}
	async function retrying(phase, method, route, body, index, originalPath) {
		let last;
		for (let attempt = 0; attempt <= config.retries; attempt++) {
			try { return await request(phase, method, route, body, index, originalPath); }
			catch (error) {
				last = error;
				if (controller.signal.aborted || attempt === config.retries || (error.status && error.status < 500 && error.status !== 429)) break;
				counters.requestRetries++;
				const backoffMs = Math.min(2000, 100 * 2 ** attempt);
				log({
					event: "retry", at: new Date().toISOString(), index, phase,
					attempt: attempt + 1, backoffMs,
					status: error.status, code: error.code ?? "transport",
				});
				// A strict receipt requires zero retries, so its verdict is irreversible at this
				// point. Finish this idempotent operation's retry, but stop admitting new work.
				// This preserves the object while avoiding hours of knowingly invalid load.
				stopping = true;
				stopReason ??= "request_retry";
				await sleep(backoffMs, undefined, { signal: controller.signal });
			}
		}
		recordError(phase, last, index); throw last;
	}
	function isWarmupCapacityBackpressure(phase, error) {
		if (phase !== "create" && phase !== "initialize") return false;
		if (![429, 503, 504].includes(error.status)) return false;
		const allowed = new Set([
			"actor_ready_timeout", "http_error", "no_admission_capacity",
			"placement_unavailable", "upstream_unavailable", "worker_unavailable",
		]);
		return allowed.has(error.code);
	}
	async function warmupRetrying(phase, method, route, body, index, scheduledAt, originalPath) {
		const deadline = scheduledAt + config.warmupBackpressureTimeoutMs;
		let attempt = 0;
		for (;;) {
			try { return await request(phase, method, route, body, index, originalPath); }
			catch (error) {
				if (controller.signal.aborted) throw error;
				if (!isWarmupCapacityBackpressure(phase, error)) {
					recordError(phase, error, index);
					stopping = true; stopReason ??= "warmup_unexpected_error"; controller.abort();
					throw error;
				}
				const backoffMs = Math.min(2000, 100 * 2 ** Math.min(attempt, 5)) + (index % 17) * 7;
				if (performance.now() + backoffMs > deadline) {
					counters.warmupBackpressureTimeouts++;
					recordError(phase, error, index);
					stopping = true; stopReason ??= "warmup_backpressure_timeout"; controller.abort();
					throw error;
				}
				attempt++;
				counters.warmupBackpressureRetries++;
				warmupBackpressureObjects.add(index);
				log({
					event: "warmup_backpressure", at: new Date().toISOString(), index, phase,
					attempt, backoffMs, status: error.status, code: error.code,
				});
				await sleep(backoffMs, undefined, { signal: controller.signal });
			}
		}
	}
	async function publishWorkers() {
		for (let shard = 0; shard < config.workers; shard++) {
			const { worker } = identity(config.runId, shard, config.workers);
			const root = `/workers/${worker}`;
			const version = await retrying("version", "POST", `${root}/versions`, {
				main_module: "main.js", modules: { "main.js": sourceFor(config.runId, shard) },
				compatibility_date: "2026-08-14", durable_objects: { AGENT: "Agent" },
			}, shard);
			if (!version?.id) throw new Error("version ID missing");
			counters.versionsPublished++;
			const deployment = await retrying("deployment", "POST", `${root}/deployments`, { version_id: version.id }, shard);
			if (!deployment?.id) throw new Error("deployment ID missing");
			counters.deploymentsPublished++;
			log({ event: "worker_ready", worker, shard, versionId: version.id, deploymentId: deployment.id });
		}
	}
	async function createAgent(index, scheduledAt, warmupPhase) {
		const { worker, objectId, shard } = identity(config.runId, index, config.workers);
		const objectPath = `/workers/${worker}/objects/Agent/${objectId}`;
		try {
			counters.createAttempts++;
			const createBegan = performance.now();
			const call = warmupPhase
				? (phase, method, route, body, originalPath) => warmupRetrying(phase, method, route, body, index, scheduledAt, originalPath)
				: (phase, method, route, body, originalPath) => retrying(phase, method, route, body, index, originalPath);
			const ref = await call("create", "PUT", objectPath, undefined);
			const createMs = performance.now() - createBegan;
			if (ref?.id !== objectId || ref?.class_name !== "Agent") throw Object.assign(new Error("ObjectRef mismatch"), { code: "identity_mismatch" });
			const initializeBegan = performance.now();
			const reply = await call("initialize", "POST", `${objectPath}/fetch`, {
				runId: config.runId, shard, agent: index, operation: "init",
			});
			const initializeMs = performance.now() - initializeBegan;
			if (reply?.runId !== config.runId || reply?.agent !== index || reply?.operation !== "init" || reply?.initialized !== true) {
				throw Object.assign(new Error("initialization identity mismatch"), { code: "identity_mismatch" });
			}
			const latency = performance.now() - scheduledAt;
			phases[warmupPhase ? "warmupReady" : "ready"].add(latency);
			counters.objectsCreated++;
			if (!warmupPhase && latency > config.readySloMs) counters.readySloBreaches++;
			counters.consecutiveCreationFailures = 0;
			if (index < config.warmup) heartbeatReady.add(index);
			if (index < config.active) { activeReady.add(index); counters.activeTargetReady = activeReady.size; }
			log({
				event: "object_ready", at: new Date().toISOString(), index, worker, objectId,
				latencyMs: latency, createMs, initializeMs, activeTarget: index < config.active,
			});
		} catch (error) {
			counters.objectsFailed++; counters.consecutiveCreationFailures++;
			if (error.code === "identity_mismatch") recordError("initialize", error, index);
			if (counters.consecutiveCreationFailures >= config.maxConsecutiveFailures) {
				stopping = true; stopReason = "consecutive_creation_failures"; controller.abort();
			}
		}
	}
	async function heartbeat(index) {
		if (!heartbeatReady.has(index) || activeInFlight.has(index) || stopping) return;
		activeInFlight.add(index); counters.activeAttempts++;
		const { worker, objectId, shard } = identity(config.runId, index, config.workers);
		const operation = `heartbeat:${activeSequence[index] + 1}`;
		try {
			const reply = await retrying("active", "POST", `/workers/${worker}/objects/Agent/${objectId}/fetch`, {
				runId: config.runId, shard, agent: index, operation,
			}, index);
			if (reply?.runId !== config.runId || reply?.agent !== index || reply?.operation !== operation || reply?.initialized !== true) {
				counters.activeIdentityMismatches++;
				throw Object.assign(new Error("heartbeat identity mismatch"), { code: "identity_mismatch" });
			}
			activeSequence[index]++; counters.activeSucceeded++;
			if (index < config.active) activeProven.add(index);
		} catch (error) {
			counters.activeFailed++;
			if (error.code === "identity_mismatch") recordError("active", error, index);
		} finally { activeInFlight.delete(index); }
	}
	const activeTickMs = Math.max(10, Math.min(100, Math.floor(config.activeIntervalMs / 10)));
	let activeCursor = 0;
	let heartbeatTarget = config.warmup;
	const activeTimer = setInterval(() => {
		const activePerTick = Math.max(1, Math.ceil(heartbeatTarget * activeTickMs / config.activeIntervalMs));
		for (let offset = 0; offset < activePerTick; offset++) {
			const index = activeCursor++ % heartbeatTarget;
			void heartbeat(index);
		}
	}, activeTickMs);

	const snapshot = () => ({
		schema: "actor-shared-agent-scale/v1", runId: config.runId, startedAt,
		elapsedSeconds: (performance.now() - began) / 1000, target: config.count, rate: config.rate,
		sharedVersionsTarget: config.workers,
		activeTarget: config.active, activeReady: activeReady.size, activeProven: activeProven.size,
		warmupTarget: config.warmup, heartbeatTarget, heartbeatReady: heartbeatReady.size,
		warmupBackpressure: {
			timeoutMs: config.warmupBackpressureTimeoutMs,
			retries: counters.warmupBackpressureRetries,
			objects: warmupBackpressureObjects.size,
			timeouts: counters.warmupBackpressureTimeouts,
		},
		readySlo: {
			limitMs: config.readySloMs,
			scope: "post-warmup_object_create_plus_initial_state",
			breaches: counters.readySloBreaches,
		},
		activeInFlight: activeInFlight.size,
		inFlight: inFlight.size, counters: { ...counters }, errors,
		latency: Object.fromEntries(Object.entries(phases).map(([name, value]) => [name, value.json()])),
		loadGeneratorRssBytes: process.memoryUsage().rss, stopReason, retained: true,
	});
	async function progress() {
		const value = snapshot();
		await writeFile(`${config.output}/progress.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
		await rename(`${config.output}/progress.tmp`, `${config.output}/progress.json`);
		console.log(JSON.stringify({ created: counters.objectsCreated, failed: counters.objectsFailed, activeReady: activeReady.size, activeSucceeded: counters.activeSucceeded, inFlight: inFlight.size, elapsedSeconds: Math.round(value.elapsedSeconds), stopReason }));
	}
	let progressTail = Promise.resolve();
	const progressTimer = setInterval(() => { progressTail = progressTail.then(progress).catch((error) => { stopping = true; stopReason = "progress_failure"; controller.abort(); console.error(error.message); }); }, 15000);
	const signalHandler = () => { stopping = true; stopReason = "signal"; controller.abort(); };
	process.once("SIGTERM", signalHandler); process.once("SIGINT", signalHandler);
	async function scheduleRange(first, end, rate, warmupPhase) {
		const schedulingBegan = performance.now();
		for (let index = first; index < end && !stopping; index++) {
			const scheduledAt = schedulingBegan + (index - first) * 1000 / rate;
			await sleep(Math.max(0, scheduledAt - performance.now()), undefined, { signal: controller.signal });
			if (performance.now() - scheduledAt > 1000 || inFlight.size >= config.maxInFlight) {
				stopping = true; stopReason = "load_generator_backlog"; break;
			}
			counters.scheduled++;
			const task = createAgent(index, scheduledAt, warmupPhase).finally(() => inFlight.delete(task));
			inFlight.add(task); counters.inFlightPeak = Math.max(counters.inFlightPeak, inFlight.size);
		}
		await Promise.allSettled(inFlight);
	}
	try {
		await publishWorkers();
		await scheduleRange(0, config.warmup, config.warmupRate, true);
		if (!stopping && counters.objectsCreated !== config.warmup) {
			stopping = true; stopReason = "warmup_failures";
		}
		if (!stopping) await sleep(config.warmupSettleMs, undefined, { signal: controller.signal });
		heartbeatTarget = config.active;
		for (const index of heartbeatReady) if (index >= config.active) heartbeatReady.delete(index);
		if (!stopping) {
			log({ event: "warmup_complete", created: counters.objectsCreated, active: config.active });
			await scheduleRange(config.warmup, config.count, config.rate, false);
		}
		if (!stopping) await sleep(config.observeAfterMs, undefined, { signal: controller.signal });
	} catch (error) {
		if (!controller.signal.aborted) { stopping = true; stopReason = "setup_failure"; recordError("setup", error); }
	} finally {
		clearInterval(activeTimer); clearInterval(progressTimer);
		await Promise.allSettled([...inFlight]);
		while (activeInFlight.size) await sleep(10);
		await progressTail; await progress(); await journalTail; await journal.sync(); await journal.close();
		process.removeListener("SIGTERM", signalHandler); process.removeListener("SIGINT", signalHandler);
	}
	if (journalFailure) throw journalFailure;
	const final = { ...snapshot(), finishedAt: new Date().toISOString() };
	final.verdict = qualificationPassed(final) ? "passed" : "failed";
	await writeFile(`${config.output}/receipt.json`, JSON.stringify(final, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	return final;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { const receipt = await run(options(process.argv.slice(2))); process.exitCode = receipt.verdict === "passed" ? 0 : 1; }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
