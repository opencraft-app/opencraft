import { describe, expect, it, vi } from "vitest";

import { AgentClient, AgentError, isAgentError } from "./index.js";

const endpoint = "https://workers.example/v1";
const fixedId = "ab".repeat(32);

function objectResponse(id = fixedId): Response {
	return Response.json({
		object: "object",
		id,
		worker: "assistant",
		class_name: "Agent",
	});
}

describe("Agent SDK", () => {
	it("creates an opaque Agent and validates the public ObjectRef", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => objectResponse());
		const client = new AgentClient({ endpoint, fetch });
		const agent = client.kind("assistant", "Agent").get(fixedId);

		const created = await agent.create();

		expect(created.ref).toEqual(agent.ref);
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]?.[0]).toBe(
			`${endpoint}/workers/assistant/objects/Agent/${fixedId}`,
		);
		expect(fetch.mock.calls[0]?.[1]?.method).toBe("PUT");
	});

	it("allocates unique lowercase 256-bit identities without network I/O", () => {
		const fetch = vi.fn();
		const kind = new AgentClient({ endpoint, fetch }).kind("assistant", "Agent");
		const first = kind.newAgent();
		const second = kind.newAgent();

		expect(first.id).toMatch(/^[0-9a-f]{64}$/);
		expect(second.id).toMatch(/^[0-9a-f]{64}$/);
		expect(first.id).not.toBe(second.id);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("round-trips AgentRef and restores a handle without network I/O", () => {
		const fetch = vi.fn();
		const client = new AgentClient({ endpoint, fetch });
		const original = client.kind("assistant", "Agent").get(fixedId);
		const serialized = JSON.parse(JSON.stringify(original));

		const restored = client.get(serialized);

		expect(restored.ref).toEqual(original.ref);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("preserves the original URL, request body, and response stream", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			expect(new Headers(init?.headers).get("x-workers-original-url")).toBe(
				"https://agent.example/messages?stream=true",
			);
			expect(await new Response(init?.body).text()).toBe("hello");
			return new Response("streamed", { status: 202 });
		});
		const agent = new AgentClient({ endpoint, fetch })
			.kind("assistant", "Agent")
			.get(fixedId);

		const response = await agent.fetch("https://agent.example/messages?stream=true", {
			method: "POST",
			body: "hello",
			headers: {
				authorization: "Bearer application-token",
				"idempotency-key": "message-1",
			},
		});

		expect(response.status).toBe(202);
		expect(await response.text()).toBe("streamed");
		expect(fetch.mock.calls[0]?.[0]).toBe(
			`${endpoint}/workers/assistant/objects/Agent/${fixedId}/fetch`,
		);
		expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toBe(
			"message-1",
		);
		expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
			"Bearer application-token",
		);
	});

	it("does not turn application HTTP errors into SDK errors", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ problem: "user code" }, { status: 500 }),
		);
		const agent = new AgentClient({ endpoint, fetch })
			.kind("assistant", "Agent")
			.get(fixedId);

		const response = await agent.fetch("https://agent.example/run", { method: "POST" });

		expect(response.status).toBe(500);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("parses stable Workers API errors and never retries", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json(
				{
					error: {
						code: "object_deleted",
						message: "The Durable Object was permanently deleted",
						retryable: false,
						request_id: "req-1",
					},
				},
				{ status: 410, headers: { "x-workers-error": "true" } },
			),
		);
		const agent = new AgentClient({ endpoint, fetch })
			.kind("assistant", "Agent")
			.get(fixedId);

		const error = await agent.fetch("https://agent.example/run").catch((value) => value);

		expect(error).toBeInstanceOf(AgentError);
		expect(isAgentError(error, "object_deleted")).toBe(true);
		expect(error).toMatchObject({ status: 410, retryable: false, requestId: "req-1" });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("deletes idempotently through the public endpoint", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			new Response(null, { status: 204 }),
		);
		const agent = new AgentClient({ endpoint, fetch })
			.kind("assistant", "Agent")
			.get(fixedId);

		await agent.delete();
		await agent.delete();

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls.every((call) => call[1]?.method === "DELETE")).toBe(true);
	});

	it("rejects invalid endpoints and persisted references", () => {
		expect(() => new AgentClient({ endpoint: "https://workers.example" })).toThrow(
			"complete Workers API /v1 URL",
		);
		const client = new AgentClient({ endpoint, fetch: vi.fn() });
		expect(() =>
			client.get({
				object: "agent",
				version: 1,
				worker: "assistant",
				class_name: "Agent",
				id: "named-agent",
			}),
		).toThrow("64-character lowercase hex");
	});
});
