import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { options, run, sourceFor, streamPlan } from "./runner.mjs";

const runId = "a".repeat(32);

test("options bind a bounded streamed load", () => {
	const value = options(["--endpoint", "http://127.0.0.1:8080/v1", "--output", "/data/tmp/stateless", "--run-id", runId]);
	assert.equal(value.durationMs, 900_000);
	assert.equal(value.holdMs, 450_000);
	assert.equal(value.rate, 2.5);
	assert.equal(value.requestTimeoutMs, 510_000);
	assert.match(sourceFor(runId, 1000), /new ReadableStream/);
	assert.match(sourceFor(runId, 1000), /setInterval/);
	const plan = streamPlan(runId, 31_000);
	assert.equal(plan.chunks.join(""), plan.response);
	assert.ok(plan.chunks[0].length >= 32 << 10);
	assert.ok(plan.intervalMs <= 15_000);
	assert.ok(plan.chunks.length >= 4);
	assert.equal(options(["--endpoint", "http://127.0.0.1/v1", "--output", "/tmp/x", "--rate", "2.5"]).rate, 2.5);
	assert.throws(() => options(["--endpoint", "http://127.0.0.1/v1", "--output", "/tmp/x", "--rate", "NaN"]));
	assert.throws(() => options(["--endpoint", "http://127.0.0.1/v1", "--output", "/tmp/x", "--hold-ms", "10", "--request-timeout-ms", "10"]));
});

test("one Version carries many genuinely streamed requests", async () => {
	let uploads = 0;
	let deployments = 0;
	let deletes = 0;
	let dispatches = 0;
	const server = createServer(async (request, response) => {
		if (request.url.endsWith("/versions")) {
			uploads++; for await (const _ of request) { /* consume */ }
			response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "v_test" })); return;
		}
		if (request.url.endsWith("/deployments")) {
			deployments++; for await (const _ of request) { /* consume */ }
			response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "d_test" })); return;
		}
		if (request.method === "DELETE") { deletes++; response.statusCode = 204; response.end(); return; }
		for await (const _ of request) { /* consume */ }
		dispatches++;
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ runId, bytes: runId.length }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const output = await mkdtemp("/data/tmp/stateless-autoscaling-runner-");
		// run() owns creation of its output directory.
		const owned = `${output}/owned`;
		const config = options([
			"--endpoint", `http://127.0.0.1:${server.address().port}/v1`, "--output", owned,
			"--run-id", runId, "--duration-ms", "80", "--hold-ms", "20", "--rate", "50",
			"--max-in-flight", "50", "--request-timeout-ms", "1000",
		]);
		const receipt = await run(config);
		assert.equal(receipt.verdict, "passed");
		assert.equal(receipt.counters.started, receipt.counters.completed);
		assert.ok(receipt.counters.started >= 3);
		assert.equal(uploads, 1); assert.equal(deployments, 1); assert.equal(deletes, 1);
		assert.equal(dispatches, receipt.counters.started);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("load evidence preserves the bounded upstream failure code", async () => {
	const server = createServer(async (request, response) => {
		for await (const _ of request) { /* consume */ }
		if (request.url.endsWith("/versions")) {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ id: "v_test" })); return;
		}
		if (request.url.endsWith("/deployments")) {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ id: "d_test" })); return;
		}
		if (request.method === "DELETE") { response.statusCode = 204; response.end(); return; }
		response.statusCode = 503;
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ code: "executor_draining" }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const output = await mkdtemp("/data/tmp/stateless-autoscaling-errors-");
		const config = options([
			"--endpoint", `http://127.0.0.1:${server.address().port}/v1`, "--output", `${output}/owned`,
			"--run-id", runId, "--duration-ms", "40", "--hold-ms", "10", "--rate", "50",
			"--max-in-flight", "50", "--request-timeout-ms", "1000",
		]);
		const receipt = await run(config);
		assert.equal(receipt.verdict, "failed");
		assert.ok(receipt.errors["503:executor_draining"] > 0);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});
