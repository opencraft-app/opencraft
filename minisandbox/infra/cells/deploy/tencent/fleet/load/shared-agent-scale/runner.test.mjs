import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { identity, options, qualificationPassed, run, sourceFor } from "./runner.mjs";

const runId = "b".repeat(32);

test("arguments and deterministic shared identities", () => {
	const parsed = options(["--endpoint", "http://127.0.0.1:8080/v1", "--output", "/data/tmp/test"]);
	assert.equal(parsed.count, 200000);
	assert.equal(parsed.active, 1000);
	assert.equal(identity(runId, 0, 2).worker, identity(runId, 2, 2).worker);
	assert.notEqual(identity(runId, 0, 2).objectId, identity(runId, 2, 2).objectId);
	assert.notEqual(sourceFor(runId, 0), sourceFor(runId, 1));
	assert.throws(() => options(["--endpoint", "http://127.0.0.1/v1", "--output", "/data/tmp/test", "--active", "3", "--count", "2"]));
});

test("a terminal active heartbeat failure cannot pass after all targets were proven", () => {
	const result = {
		stopReason: null, target: 200000, activeTarget: 1000,
		activeReady: 1000, activeProven: 1000,
		counters: {
			objectsCreated: 200000, objectsFailed: 0, readySloBreaches: 0,
			requestRetries: 0, activeFailed: 1, activeIdentityMismatches: 0,
		},
	};
	assert.equal(qualificationPassed(result), false);
	result.counters.activeFailed = 0;
	assert.equal(qualificationPassed(result), true);
	result.counters.requestRetries = 1;
	assert.equal(qualificationPassed(result), false);
});

async function protocolServer(callback, objectDelayMs = 0, failOncePredicate = null, failOnceCode = "injected_unavailable") {
	const uploads = [];
	const deployments = [];
	const states = new Map();
	let injectedFailure = false;
	const server = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		const body = text ? JSON.parse(text) : null;
		res.setHeader("content-type", "application/json");
		if (!injectedFailure && failOncePredicate?.(req)) {
			injectedFailure = true;
			res.statusCode = 503;
			res.end(JSON.stringify(failOnceCode === "http_error" ? {} : { error: { code: failOnceCode } }));
			return;
		}
		if (req.url.endsWith("/versions")) { uploads.push(body); res.end(JSON.stringify({ id: `v-${uploads.length}` })); return; }
		if (req.url.endsWith("/deployments")) { deployments.push(body); res.end(JSON.stringify({ id: `d-${deployments.length}` })); return; }
		const objectId = req.url.split("/").filter(Boolean).at(req.url.endsWith("/fetch") ? -2 : -1);
		if (req.method === "PUT") {
			if (objectDelayMs) await new Promise((resolve) => setTimeout(resolve, objectDelayMs));
			states.set(objectId, { initialized: false, heartbeats: 0, operations: new Map() });
			res.end(JSON.stringify({ id: objectId, class_name: "Agent" }));
			return;
		}
		const state = states.get(objectId);
		if (req.headers["x-workers-original-url"] === "https://agent.example/state") { res.end(JSON.stringify(state)); return; }
		let reply = state.operations.get(body.operation);
		if (!reply) {
			if (body.operation === "init") state.initialized = true; else state.heartbeats++;
			reply = { runId: body.runId, agent: body.agent, operation: body.operation, initialized: state.initialized, heartbeats: state.heartbeats };
			state.operations.set(body.operation, reply);
		}
		res.end(JSON.stringify(reply));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try { await callback(`http://127.0.0.1:${server.address().port}/v1`, { uploads, deployments, states }); }
	finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("few shared versions create many independent objects and keep a bounded hot set", async () => {
	await protocolServer(async (endpoint, observed) => {
		const output = await mkdtemp("/data/tmp/shared-agent-scale-test-");
		const config = options([
			"--endpoint", endpoint, "--output", output, "--run-id", runId,
			"--count", "20", "--rate", "200", "--active", "5", "--workers", "2",
			"--warmup", "8", "--warmup-rate", "200", "--warmup-settle-ms", "10",
			"--active-interval-ms", "50", "--observe-after-ms", "150", "--timeout-ms", "1000",
		]);
		const receipt = await run(config);
		assert.equal(receipt.verdict, "passed");
		assert.equal(receipt.counters.versionsPublished, 2);
		assert.equal(receipt.counters.deploymentsPublished, 2);
		assert.equal(receipt.sharedVersionsTarget, 2);
		assert.deepEqual(receipt.readySlo, {
			limitMs: 3000,
			scope: "post-warmup_object_create_plus_initial_state",
			breaches: 0,
		});
		assert.equal(receipt.counters.objectsCreated, 20);
		assert.equal(receipt.activeReady, 5);
		assert.equal(receipt.activeProven, 5);
		assert.ok(receipt.counters.activeSucceeded >= 5);
		assert.equal(observed.uploads.length, 2);
		assert.equal(observed.deployments.length, 2);
		assert.equal(observed.states.size, 20);
		for (let index = 0; index < 5; index++) {
			assert.ok(observed.states.get(identity(runId, index, 2).objectId).heartbeats > 0);
		}
		assert.ok([...observed.states.values()].filter((state) => state.heartbeats > 0).length <= 8);
		const events = (await readFile(join(output, "events.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
		assert.equal(events.filter((row) => row.event === "worker_ready").length, 2);
		const readyEvents = events.filter((row) => row.event === "object_ready");
		assert.equal(readyEvents.length, 20);
		assert.match(readyEvents[0].at, /^\d{4}-\d{2}-\d{2}T/);
		assert.equal(typeof readyEvents[0].createMs, "number");
		assert.equal(typeof readyEvents[0].initializeMs, "number");
	});
});

test("steady-state readiness SLO breach fails the qualification", async () => {
	await protocolServer(async (endpoint) => {
		const output = await mkdtemp("/data/tmp/shared-agent-scale-slo-test-");
		const config = options([
			"--endpoint", endpoint, "--output", output, "--run-id", "c".repeat(32),
			"--count", "2", "--rate", "100", "--active", "1", "--workers", "1",
			"--warmup", "1", "--warmup-rate", "100", "--warmup-settle-ms", "1",
			"--active-interval-ms", "20", "--observe-after-ms", "30", "--timeout-ms", "1000",
			"--ready-slo-ms", "5",
		]);
		const receipt = await run(config);
		assert.equal(receipt.counters.objectsCreated, 2);
		assert.equal(receipt.counters.objectsFailed, 0);
		assert.equal(receipt.counters.readySloBreaches, 1);
		assert.equal(receipt.readySlo.limitMs, 5);
		assert.equal(receipt.readySlo.breaches, 1);
		assert.equal(receipt.verdict, "failed");
	}, 20);
});

test("bounded warmup capacity backpressure preserves the idempotent operation", async () => {
	await protocolServer(async (endpoint) => {
		const output = await mkdtemp("/data/tmp/shared-agent-scale-warmup-backpressure-test-");
		const config = options([
			"--endpoint", endpoint, "--output", output, "--run-id", "d".repeat(32),
			"--count", "1", "--rate", "100", "--active", "1", "--workers", "1",
			"--warmup", "1", "--warmup-rate", "100", "--warmup-settle-ms", "1",
			"--warmup-backpressure-timeout-ms", "1000",
			"--active-interval-ms", "20", "--observe-after-ms", "30", "--timeout-ms", "1000",
		]);
		const receipt = await run(config);
		assert.equal(receipt.stopReason, null);
		assert.equal(receipt.counters.objectsCreated, 1);
		assert.equal(receipt.counters.objectsFailed, 0);
		assert.equal(receipt.counters.requestRetries, 0);
		assert.equal(receipt.counters.warmupBackpressureRetries, 1);
		assert.equal(receipt.counters.warmupBackpressureTimeouts, 0);
		assert.deepEqual(receipt.warmupBackpressure, { timeoutMs: 1000, retries: 1, objects: 1, timeouts: 0 });
		assert.equal(receipt.verdict, "passed");
		const events = (await readFile(join(output, "events.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
		const retries = events.filter((row) => row.event === "warmup_backpressure");
		assert.equal(retries.length, 1);
		assert.deepEqual({ ...retries[0], at: undefined }, {
			event: "warmup_backpressure", at: undefined, index: 0, phase: "initialize",
			attempt: 1, backoffMs: 100, status: 503, code: "http_error",
		});
	}, 0, (req) => req.url.endsWith("/fetch"), "http_error");
});

test("a steady-state retryable request still stops new work after preserving the operation", async () => {
	const steadyObject = identity("e".repeat(32), 1, 1).objectId;
	await protocolServer(async (endpoint) => {
		const output = await mkdtemp("/data/tmp/shared-agent-scale-retry-test-");
		const config = options([
			"--endpoint", endpoint, "--output", output, "--run-id", "e".repeat(32),
			"--count", "2", "--rate", "100", "--active", "1", "--workers", "1",
			"--warmup", "1", "--warmup-rate", "100", "--warmup-settle-ms", "1",
			"--active-interval-ms", "20", "--observe-after-ms", "30", "--timeout-ms", "1000",
		]);
		const receipt = await run(config);
		assert.equal(receipt.stopReason, "request_retry");
		assert.equal(receipt.counters.objectsCreated, 2);
		assert.equal(receipt.counters.objectsFailed, 0);
		assert.equal(receipt.counters.requestRetries, 1);
		assert.equal(receipt.verdict, "failed");
		const events = (await readFile(join(output, "events.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
		const retries = events.filter((row) => row.event === "retry");
		assert.equal(retries.length, 1);
		assert.match(retries[0].at, /^\d{4}-\d{2}-\d{2}T/);
		assert.deepEqual({ ...retries[0], at: undefined }, {
			event: "retry", at: undefined, index: 1, phase: "initialize", attempt: 1,
			backoffMs: 100, status: 503, code: "injected_unavailable",
		});
	}, 0, (req) => req.url.includes(steadyObject) && req.url.endsWith("/fetch"));
});
