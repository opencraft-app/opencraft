import { AgentClient } from "../dist/index.js";

const endpoint = process.env.WORKERS_API_ENDPOINT;
const worker = process.env.AGENT_WORKER;
const className = process.env.AGENT_CLASS;
const action = process.argv[2];

if (!endpoint || !worker || !className || !["create", "call", "delete"].includes(action)) {
	console.error(
		"Usage: WORKERS_API_ENDPOINT=... AGENT_WORKER=... AGENT_CLASS=... " +
			"[AGENT_REF='...'] node examples/persistent-agent.mjs create|call|delete",
	);
	process.exit(2);
}

const client = new AgentClient({ endpoint });
const kind = client.kind(worker, className);

if (action === "create") {
	const agent = kind.newAgent();
	await agent.create();
	process.stdout.write(`${JSON.stringify(agent.ref)}\n`);
} else {
	if (!process.env.AGENT_REF) {
		console.error("AGENT_REF is required for call and delete");
		process.exit(2);
	}
	const agent = client.get(JSON.parse(process.env.AGENT_REF));
	if (action === "delete") {
		await agent.delete();
		process.stdout.write("deleted\n");
	} else {
		const response = await agent.fetch("https://agent.local/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": crypto.randomUUID(),
			},
			body: JSON.stringify({ message: process.env.MESSAGE ?? "hello" }),
		});
		process.stdout.write(`${response.status} ${await response.text()}\n`);
	}
}
