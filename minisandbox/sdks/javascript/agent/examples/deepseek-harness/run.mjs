import "./build.mjs";

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "@minisandbox/miniflare";
import { AgentClient } from "../../dist/index.js";

const endpoint = process.env.WORKERS_API_ENDPOINT;
if (!endpoint) throw new Error("WORKERS_API_ENDPOINT is required");

const root = dirname(fileURLToPath(import.meta.url));
const script = await readFile(join(root, "dist/worker.js"), "utf8");
const worker = `deepseek-harness-${Date.now().toString(36)}`;
const mf = new Miniflare({
	endpoint,
	name: worker,
	modules: [{ type: "ESModule", path: "main.js", contents: script }],
	mainModule: "main.js",
	compatibilityDate: "2026-08-14",
	durableObjects: { AGENT: "DeepSeekHarnessAgent" },
});

const client = new AgentClient({ endpoint });
const agent = client.kind(worker, "DeepSeekHarnessAgent").newAgent();
const automaticCompactionAgent = client.kind(worker, "DeepSeekHarnessAgent").newAgent();
const manualCompactionAgent = client.kind(worker, "DeepSeekHarnessAgent").newAgent();

try {
	await mf.ready;
	await agent.create();
	const unauthorized = await agent.fetch("https://agent.example/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "must not run" }),
	});
	if (unauthorized.status !== 401) {
		throw new Error(`Missing model credential returned HTTP ${unauthorized.status}, expected 401`);
	}
	const first = await turn(agent, "Reply with exactly: first-turn-ok");
	const second = await turn(agent, "Reply with exactly: second-turn-ok");
	if (second.event_count <= first.event_count) {
		throw new Error(`Harness history did not grow: ${first.event_count} -> ${second.event_count}`);
	}
	await agent.delete();

	await automaticCompactionAgent.create();
	let automatic;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		automatic = await turn(
			automaticCompactionAgent,
			`pressure-${attempt}: ${"context ".repeat(120)}`,
			true,
		);
		if (automatic.compaction_count > 0) break;
	}
	if (!automatic || automatic.compaction_count === 0) {
		throw new Error("Automatic context compaction did not trigger under deterministic pressure");
	}
	const afterAutomatic = await turn(
		automaticCompactionAgent,
		"The compacted session must remain usable.",
		true,
	);
	if (afterAutomatic.compaction_count < automatic.compaction_count) {
		throw new Error("Automatic compaction markers were not restored on the next request");
	}
	await automaticCompactionAgent.delete();

	await manualCompactionAgent.create();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await turn(manualCompactionAgent, `manual-${attempt}: ${"history ".repeat(30)}`, true);
	}
	const manual = await compact(manualCompactionAgent);
	if (!manual.compacted || manual.compaction_count === 0) {
		throw new Error("Explicit context compaction did not compact useful history");
	}
	const afterManual = await turn(
		manualCompactionAgent,
		"The manually compacted session must remain usable.",
		true,
	);
	if (afterManual.compaction_count < manual.compaction_count) {
		throw new Error("Manual compaction markers were not restored on the next request");
	}

	console.log(
		JSON.stringify({ worker, first, second, automatic, afterAutomatic, manual, afterManual }),
	);
} finally {
	await Promise.all([
		agent.delete().catch(() => undefined),
		automaticCompactionAgent.delete().catch(() => undefined),
		manualCompactionAgent.delete().catch(() => undefined),
	]);
	await mf.dispose();
}

async function turn(target, message, forceEcho = false) {
	const headers = new Headers({ "content-type": "application/json" });
	if (process.env.CLOUDAGENTS_API_KEY && !forceEcho) {
		headers.set("authorization", `Bearer ${process.env.CLOUDAGENTS_API_KEY}`);
	} else {
		headers.set("x-harness-test-provider", "echo");
	}
	const response = await target.fetch("https://agent.example/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({ message }),
	});
	if (!response.ok) {
		throw new Error(`Agent returned HTTP ${response.status}: ${await response.text()}`);
	}
	return response.json();
}

async function compact(target) {
	const response = await target.fetch("https://agent.example/compact", {
		method: "POST",
		headers: { "x-harness-test-provider": "echo" },
	});
	if (!response.ok) {
		throw new Error(`Manual compaction returned HTTP ${response.status}: ${await response.text()}`);
	}
	return response.json();
}
