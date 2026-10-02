import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export function options(argv) {
	const result = {
		endpoint: "", output: "", count: 100000, rate: 20,
		durationMs: 30000, intervalMs: 1000, timeoutMs: 15000,
		maxInFlight: 4096, maxConsecutiveFailures: 100, readySloMs: 3000,
		runId: randomUUID().replaceAll("-", ""),
	};
	const names = {
		"--endpoint": "endpoint", "--output": "output", "--count": "count",
		"--rate": "rate", "--duration-ms": "durationMs", "--interval-ms": "intervalMs",
		"--timeout-ms": "timeoutMs", "--max-in-flight": "maxInFlight",
		"--max-consecutive-failures": "maxConsecutiveFailures",
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
	const url = new URL(result.endpoint);
	if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") {
		throw new Error("endpoint must be a credential-free public /v1 URL");
	}
	if (!result.output || !/^[a-f0-9]{32}$/.test(result.runId)) throw new Error("output and a 32-hex run ID are required");
	result.endpoint = result.endpoint.replace(/\/$/, "");
	result.output = resolve(result.output);
	return result;
}

export function agentIdentity(runId, index) {
	const worker = `soak-${runId}-${index}`;
	return { worker, objectId: createHash("sha256").update(`${worker}\0agent`).digest("hex") };
}

export function sourceFor(runId, index) {
	return `// Independent upload ${runId}:${index}.
import { DurableObject } from "cloudflare:workers";
export class Agent extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/state") {
      return Response.json((await this.ctx.storage.get("state")) ?? { turns: [] });
    }
    const message = await request.json();
    if (message.runId !== ${JSON.stringify(runId)} || message.agent !== ${index} || !Number.isInteger(message.turn)) {
      return new Response("invalid message", { status: 400 });
    }
    const operation = "turn:" + message.turn;
    const replay = await this.ctx.storage.get(operation);
    if (replay !== undefined) return Response.json(replay);
    const state = (await this.ctx.storage.get("state")) ?? { turns: [] };
    state.turns.push(message.turn);
    const response = { runId: message.runId, agent: message.agent, turn: message.turn, count: state.turns.length };
    await this.ctx.storage.put({ state, [operation]: response });
    return Response.json(response);
  }
}
export default { fetch() { return new Response("ready"); } };`;
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
	const journal = await open(`${config.output}/agents.ndjson`, "ax", 0o600);
	const counters = {
		scheduled: 0, uploadAttempts: 0, uploadsSucceeded: 0, deploymentsSucceeded: 0,
		agentsReady: 0, agentsCompleted: 0, agentsFailed: 0, readySloBreaches: 0,
		interactionAttempts: 0, interactionsSucceeded: 0, interactionsFailed: 0,
		missedInteractionSlots: 0, acknowledgedStateMismatches: 0,
		consecutiveCreationFailures: 0, inFlightPeak: 0,
	};
	const errors = {};
	const phases = Object.fromEntries(["upload", "deployment", "create", "ready", "message", "state"].map((name) => [name, new Histogram()]));
	const inFlight = new Set();
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
		log({ event: "error", index, phase, status: error.status, code: error.code ?? "transport" });
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
		} catch (error) {
			recordError(phase, error, index); throw error;
		} finally { phases[phase].add(performance.now() - start); }
	}
	async function agent(index, scheduledAt) {
		const { worker, objectId } = agentIdentity(config.runId, index);
		const root = `/workers/${worker}`;
		const objectPath = `${root}/objects/Agent/${objectId}`;
		const acknowledged = [];
		let ready = false;
		try {
			counters.uploadAttempts++;
			const version = await request("upload", "POST", `${root}/versions`, {
				main_module: "main.js", modules: { "main.js": sourceFor(config.runId, index) },
				compatibility_date: "2026-08-14", durable_objects: { AGENT: "Agent" },
			}, index);
			if (!version?.id) throw new Error("version ID missing");
			counters.uploadsSucceeded++;
			log({ event: "uploaded", index, worker, objectId, versionId: version.id });
			const deployment = await request("deployment", "POST", `${root}/deployments`, { version_id: version.id }, index);
			if (!deployment?.id) throw new Error("deployment ID missing");
			counters.deploymentsSucceeded++;
			const ref = await request("create", "PUT", objectPath, undefined, index);
			if (ref?.id !== objectId || ref?.class_name !== "Agent") throw new Error("ObjectRef mismatch");
			const interactingAt = performance.now();
			for (let turn = 0; turn * config.intervalMs < config.durationMs; turn++) {
				const target = interactingAt + turn * config.intervalMs;
				await sleep(Math.max(0, target - performance.now()), undefined, { signal: controller.signal });
				if (turn > 0 && performance.now() - target >= config.intervalMs) { counters.missedInteractionSlots++; continue; }
				counters.interactionAttempts++;
				try {
					const reply = await request("message", "POST", `${objectPath}/fetch`, {
						runId: config.runId, agent: index, turn, message: "hello persistent agent",
					}, index);
					if (reply?.runId !== config.runId || reply?.agent !== index || reply?.turn !== turn) {
						throw Object.assign(new Error("message identity mismatch"), { code: "identity_mismatch" });
					}
					acknowledged.push(turn); counters.interactionsSucceeded++;
					if (!ready) {
						const latency = performance.now() - scheduledAt;
						phases.ready.add(latency); counters.agentsReady++;
						if (latency > config.readySloMs) counters.readySloBreaches++;
						counters.consecutiveCreationFailures = 0; ready = true;
						log({ event: "ready", index, worker, objectId, deploymentId: deployment.id, latencyMs: latency });
					}
				} catch (error) {
					counters.interactionsFailed++;
					if (error.code === "identity_mismatch") recordError("message", error, index);
					if (!ready) throw error;
				}
			}
			await sleep(Math.max(0, interactingAt + config.durationMs - performance.now()), undefined, { signal: controller.signal });
			const state = await request("state", "GET", `${objectPath}/fetch`, undefined, index, "/state");
			if (!Array.isArray(state?.turns) || acknowledged.some((turn) => !state.turns.includes(turn)) || new Set(state.turns).size !== state.turns.length) {
				counters.acknowledgedStateMismatches++;
				throw Object.assign(new Error("acknowledged state missing or duplicated"), { code: "state_mismatch" });
			}
			counters.agentsCompleted++;
			log({ event: "completed", index, acknowledgedTurns: acknowledged.length, storedTurns: state.turns.length, retained: true });
		} catch (error) {
			counters.agentsFailed++;
			if (!ready) counters.consecutiveCreationFailures++;
			if (error.code === "state_mismatch" || !error.status && !error.code) recordError("agent", error, index);
			if (counters.acknowledgedStateMismatches || counters.consecutiveCreationFailures >= config.maxConsecutiveFailures) {
				stopping = true; stopReason = counters.acknowledgedStateMismatches ? "correctness_failure" : "consecutive_creation_failures";
			}
		}
	}
	const snapshot = () => ({
		schema: "actor-agent-upload-soak/v1", runId: config.runId, startedAt,
		elapsedSeconds: (performance.now() - began) / 1000, target: config.count, rate: config.rate,
		inFlight: inFlight.size, counters: { ...counters }, errors,
		latency: Object.fromEntries(Object.entries(phases).map(([name, value]) => [name, value.json()])),
		loadGeneratorRssBytes: process.memoryUsage().rss, stopReason,
		retained: true, naturalSleepVerified: false, cloudScaleOutVerified: false,
	});
	async function progress() {
		const value = snapshot();
		await writeFile(`${config.output}/progress.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
		await rename(`${config.output}/progress.tmp`, `${config.output}/progress.json`);
		console.log(JSON.stringify({ scheduled: counters.scheduled, uploads: counters.uploadsSucceeded, ready: counters.agentsReady, completed: counters.agentsCompleted, failed: counters.agentsFailed, inFlight: inFlight.size, elapsedSeconds: Math.round(value.elapsedSeconds), stopReason }));
	}
	let progressTail = Promise.resolve();
	const timer = setInterval(() => { progressTail = progressTail.then(progress).catch((error) => { stopping = true; stopReason = "progress_failure"; controller.abort(); console.error(error.message); }); }, 15000);
	const signalHandler = () => { stopping = true; stopReason = "signal"; controller.abort(); };
	process.once("SIGTERM", signalHandler); process.once("SIGINT", signalHandler);
	try {
		for (let index = 0; index < config.count && !stopping; index++) {
			const scheduledAt = began + index * 1000 / config.rate;
			await sleep(Math.max(0, scheduledAt - performance.now()), undefined, { signal: controller.signal });
			if (stopping) break;
			if (performance.now() - scheduledAt > 1000 || inFlight.size >= config.maxInFlight) {
				stopping = true; stopReason = "load_generator_backlog"; break;
			}
			counters.scheduled++;
			const task = agent(index, scheduledAt).finally(() => inFlight.delete(task));
			inFlight.add(task); counters.inFlightPeak = Math.max(counters.inFlightPeak, inFlight.size);
		}
	} catch (error) {
		if (!controller.signal.aborted) throw error;
	} finally {
		await Promise.allSettled(inFlight);
		clearInterval(timer); await progressTail; await progress();
		await journalTail; await journal.sync(); await journal.close();
		process.removeListener("SIGTERM", signalHandler); process.removeListener("SIGINT", signalHandler);
	}
	if (journalFailure) throw journalFailure;
	const final = { ...snapshot(), finishedAt: new Date().toISOString() };
	final.verdict = !stopReason && counters.agentsCompleted === config.count && counters.agentsFailed === 0 && counters.interactionsFailed === 0 && counters.missedInteractionSlots === 0 ? "passed" : "failed";
	await writeFile(`${config.output}/receipt.json`, JSON.stringify(final, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	return final;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { const receipt = await run(options(process.argv.slice(2))); process.exitCode = receipt.verdict === "passed" ? 0 : 1; }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
