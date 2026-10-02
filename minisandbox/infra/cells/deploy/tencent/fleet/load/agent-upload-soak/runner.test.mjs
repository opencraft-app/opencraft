import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { agentIdentity, options, run, sourceFor } from "./runner.mjs";

const runId = "a".repeat(32);

test("arguments require /v1 and reject unbounded or invalid work", () => {
	assert.equal(options(["--endpoint", "http://127.0.0.1:8080/v1", "--output", "/data/tmp/test"]).rate, 20);
	for (const argv of [
		["--endpoint", "http://127.0.0.1:8080", "--output", "/data/tmp/test"],
		["--endpoint", "http://user:secret@127.0.0.1/v1", "--output", "/data/tmp/test"],
		["--endpoint", "http://127.0.0.1/v1", "--output", "/data/tmp/test", "--rate", "0"],
	]) assert.throws(() => options(argv));
	assert.notEqual(sourceFor(runId, 0), sourceFor(runId, 1));
	assert.notEqual(agentIdentity(runId, 0).objectId, agentIdentity(runId, 1).objectId);
});

async function protocolServer(callback, failUploads = false) {
	const uploads = [];
	const states = new Map();
	let deletes = 0;
	const server = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		const body = text ? JSON.parse(text) : null;
		res.setHeader("content-type", "application/json");
		if (req.method === "DELETE") { deletes++; res.end("{}"); return; }
		if (req.url.endsWith("/versions")) {
			if (failUploads) { res.statusCode = 503; res.end(JSON.stringify({ error: { code: "unavailable" } })); return; }
			uploads.push(body); res.end(JSON.stringify({ id: `v-${uploads.length}` })); return;
		}
		if (req.url.endsWith("/deployments")) { res.end(JSON.stringify({ id: "deployment" })); return; }
		const objectId = req.url.split("/").filter(Boolean).at(req.url.endsWith("/fetch") ? -2 : -1);
		if (req.method === "PUT") { states.set(objectId, []); res.end(JSON.stringify({ id: objectId, class_name: "Agent" })); return; }
		if (req.headers["x-workers-original-url"] === "https://agent.example/state") {
			res.end(JSON.stringify({ turns: states.get(objectId) })); return;
		}
		states.get(objectId).push(body.turn);
		res.end(JSON.stringify({ runId: body.runId, agent: body.agent, turn: body.turn }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try { await callback(`http://127.0.0.1:${server.address().port}/v1`, { uploads, states, deletes: () => deletes }); }
	finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("independent uploads, interaction, retained objects and bounded receipt", async () => {
	await protocolServer(async (endpoint, observed) => {
		const output = await mkdtemp("/data/tmp/agent-upload-test-");
		const config = options(["--endpoint", endpoint, "--output", output, "--run-id", runId, "--count", "2", "--rate", "10", "--duration-ms", "60", "--interval-ms", "20"]);
		const receipt = await run(config);
		assert.equal(receipt.verdict, receipt.counters.missedInteractionSlots ? "failed" : "passed");
		assert.equal(receipt.counters.uploadAttempts, 2);
		assert.equal(receipt.counters.agentsCompleted, 2);
		assert.equal(receipt.counters.interactionsSucceeded, receipt.counters.interactionAttempts);
		assert.equal(receipt.counters.interactionAttempts + receipt.counters.missedInteractionSlots, 6);
		assert.equal(observed.uploads.length, 2);
		assert.notEqual(observed.uploads[0].modules["main.js"], observed.uploads[1].modules["main.js"]);
		assert.equal(observed.deletes(), 0);
		assert.equal(receipt.cloudScaleOutVerified, false);
		const journal = (await readFile(join(output, "agents.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
		assert.equal(journal.filter((row) => row.event === "uploaded").length, 2);
		await assert.rejects(() => run(config), /EEXIST/);
	});
});

test("upload errors are not retried or counted as success", async () => {
	await protocolServer(async (endpoint) => {
		const output = await mkdtemp("/data/tmp/agent-upload-failure-test-");
		const config = options(["--endpoint", endpoint, "--output", output, "--run-id", runId, "--count", "5", "--rate", "2", "--max-consecutive-failures", "1"]);
		const receipt = await run(config);
		assert.equal(receipt.verdict, "failed");
		assert.equal(receipt.stopReason, "consecutive_creation_failures");
		assert.equal(receipt.counters.uploadAttempts, 1);
		assert.equal(receipt.counters.uploadsSucceeded, 0);
		assert.equal(receipt.counters.agentsReady, 0);
	}, true);
});
