import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Miniflare, MiniflareError, type MiniflareOptions } from "./index.js";

const VERSION_ONE = `v_${"1".repeat(64)}`;
const VERSION_TWO = `v_${"2".repeat(64)}`;
const SCRIPT = `
export class Counter { fetch() { return new Response("ok"); } }
export default { fetch() { return new Response("ready"); } };
`;

interface SeenRequest {
	url: URL;
	method: string;
	headers: Headers;
	body?: unknown;
}

describe("Miniflare v3 public Workers API facade", () => {
	let seen: SeenRequest[];
	let activeVersion: string | null;
	let activeDeployment: string | null;
	let failDeployment: boolean;

	beforeEach(() => {
		seen = [];
		activeVersion = null;
		activeDeployment = null;
		failDeployment = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const request = new Request(input, init);
				const text = await request.text();
				seen.push({
					url: new URL(request.url),
					method: request.method,
					headers: new Headers(request.headers),
					body: text === "" ? undefined : safeJSON(text),
				});
				const url = new URL(request.url);
				if (url.pathname === "/v1/workers/counter/versions" && request.method === "POST") {
					const version =
						text.includes("version 2") || text.includes("MissingCounter")
							? VERSION_TWO
							: VERSION_ONE;
					return Response.json(versionResource(version), { status: 201 });
				}
				if (url.pathname === "/v1/workers/counter/deployments" && request.method === "POST") {
					if (failDeployment) {
						failDeployment = false;
						return publicError(422, "worker_prepare_failed", "Worker does not export Counter");
					}
					const input = JSON.parse(text) as {
						version_id: string;
						expected_deployment_id?: string;
					};
					if (
						input.expected_deployment_id !== undefined &&
						input.expected_deployment_id !== activeDeployment
					) {
						return publicError(409, "deployment_conflict", "Deployment changed");
					}
					activeVersion = input.version_id;
					activeDeployment = deploymentID(activeVersion);
					return Response.json(deploymentResource(activeVersion), { status: 201 });
				}
				if (url.pathname === "/v1/workers/counter" && request.method === "GET") {
					if (activeVersion === null) return publicError(404, "not_found", "Worker was not found");
					return Response.json({
						object: "worker",
						name: "counter",
						deployment: deploymentResource(activeVersion),
						versions: [versionResource(activeVersion)],
					});
				}
				if (
					new RegExp("^/v1/workers/counter/objects/Counter/[0-9a-f]{64}/fetch$").test(
						url.pathname,
					)
				) {
					return Response.json({ ok: true }, { status: 201 });
				}
				if (
					new RegExp("^/v1/workers/counter/objects/Counter/[0-9a-f]{64}$").test(
						url.pathname,
					) && request.method === "DELETE"
				) {
					return new Response(null, { status: 204 });
				}
				if (url.pathname === "/v1/workers/counter/dispatch") {
					return new Response("ready");
				}
				return publicError(404, "not_found", "Unexpected route");
			}),
		);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("deploys and fetches through one fixed /v1 endpoint", async () => {
		const mf = createMiniflare();
		await mf.ready;
		const namespace = await mf.getDurableObjectNamespace("COUNTER");
		const response = await namespace.getByName("alice").fetch("https://worker.test/increment?by=1", {
			method: "POST",
		});

		expect(response.status).toBe(201);
		expect(seen.map((request) => request.url.pathname)).toEqual([
			"/v1/workers/counter/versions",
			"/v1/workers/counter/deployments",
			`/v1/workers/counter/objects/Counter/${objectID()}/fetch`,
		]);
		expect(seen[1].body).toEqual({
			version_id: VERSION_ONE,
		});
		expect(seen[0].body).toMatchObject({
			durable_objects: { COUNTER: "Counter" },
		});
		expect(seen[2].headers.get("x-workers-original-url")).toBe(
			"https://worker.test/increment?by=1",
		);
		for (const request of seen) {
			expect(request.url.origin).toBe("https://api.internal");
			expect(request.url.pathname).not.toContain("namespace");
		}
	});

	it("returns stable Worker, Version, and Deployment resources", async () => {
		const mf = createMiniflare();
		await mf.ready;
		const worker = await mf.getWorker();

		expect(worker.object).toBe("worker");
		expect(worker.name).toBe("counter");
		expect(worker.deployment?.object).toBe("deployment");
		expect(worker.versions[0]).toMatchObject({ object: "version", id: VERSION_ONE });
		expect(JSON.stringify(worker)).not.toMatch(/namespace|runner|datacenter|actor_id/);
	});

	it("uses the public dispatch endpoint for a stateless fetch", async () => {
		const mf = createMiniflare({ durableObjects: {} });
		await mf.ready;
		const response = await mf.dispatchFetch("https://worker.test/hello");

		expect(await response.text()).toBe("ready");
		expect(seen.at(-1)?.url.pathname).toBe("/v1/workers/counter/dispatch");
		expect(seen.at(-1)?.headers.get("x-workers-original-url")).toBe(
			"https://worker.test/hello",
		);
	});

	it("propagates caller cancellation instead of imposing the control-plane timeout", async () => {
		let executionSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : input.toString());
				if (url.pathname.includes("/objects/")) {
					executionSignal = init?.signal ?? undefined;
					return new Response("ok");
				}
				if (url.pathname.endsWith("/versions")) {
					return Response.json(versionResource(VERSION_ONE), { status: 201 });
				}
				if (url.pathname.endsWith("/deployments")) {
					return Response.json(deploymentResource(VERSION_ONE), { status: 201 });
				}
				return publicError(404, "not_found", "Unexpected route");
			}),
		);
		const mf = createMiniflare();
		await mf.ready;
		const namespace = await mf.getDurableObjectNamespace("COUNTER");
		const controller = new AbortController();

		await namespace.getByName("alice").fetch("https://worker.test/chat", {
			signal: controller.signal,
		});
		expect(executionSignal?.aborted).toBe(false);
		controller.abort();
		expect(executionSignal?.aborted).toBe(true);
	});

	it("deletes one Durable Object through the stable public identity", async () => {
		const mf = createMiniflare();
		await mf.ready;
		const namespace = await mf.getDurableObjectNamespace("COUNTER");
		const stub = namespace.getByName("alice");

		await stub.delete();

		expect(seen.at(-1)).toMatchObject({
			method: "DELETE",
		});
		expect(seen.at(-1)?.url.pathname).toBe(
			`/v1/workers/counter/objects/Counter/${objectID()}`,
		);
	});

	it("surfaces the unified public error and restores options after rejection", async () => {
		const mf = createMiniflare();
		await mf.ready;
		const oldNamespace = await mf.getDurableObjectNamespace("COUNTER");
		const oldStub = oldNamespace.getByName("alice");
		failDeployment = true;

		await expect(mf.setOptions(options(`${SCRIPT}\n// version 2`))).rejects.toMatchObject({
			code: "worker_prepare_failed",
			status: 422,
			retryable: false,
			requestId: "req_test",
		});
		await expect(oldStub.fetch("https://worker.test/")).rejects.toMatchObject({
			code: "ERR_STALE_STUB",
		});
		await mf.setOptions(options(SCRIPT));
		const recovered = await mf.getDurableObjectNamespace("COUNTER");
		expect(await recovered.getByName("alice").fetch("https://worker.test/")).toBeInstanceOf(
			Response,
		);
		expect(activeVersion).toBe(VERSION_ONE);
	});

	it("uploads identical code with different Durable Object config as a different Version", async () => {
		const mf = createMiniflare();
		await mf.ready;
		await mf.setOptions({
			...options(SCRIPT),
			durableObjects: { COUNTER: "MissingCounter" },
		});

		const uploads = seen.filter((request) => request.url.pathname.endsWith("/versions"));
		expect(uploads).toHaveLength(2);
		expect(uploads[0].body).toMatchObject({ durable_objects: { COUNTER: "Counter" } });
		expect(uploads[1].body).toMatchObject({ durable_objects: { COUNTER: "MissingCounter" } });
		expect(activeVersion).toBe(VERSION_TWO);
	});

	it("invalidates stale stubs after a successful update", async () => {
		const mf = createMiniflare();
		const namespace = await mf.getDurableObjectNamespace("COUNTER");
		const stale = namespace.getByName("alice");

		await mf.setOptions(options(`${SCRIPT}\n// version 2`));
		await expect(stale.fetch("https://worker.test/")).rejects.toMatchObject({
			code: "ERR_STALE_STUB",
		});
		expect(activeVersion).toBe(VERSION_TWO);
		expect(seen.at(-1)?.body).toMatchObject({
			expected_deployment_id: deploymentID(VERSION_ONE),
		});
	});

	it("keeps stubs usable when setOptions fails synchronous local validation", async () => {
		const mf = createMiniflare();
		const namespace = await mf.getDurableObjectNamespace("COUNTER");
		const stub = namespace.getByName("alice");

		await expect(
			mf.setOptions({ ...options(SCRIPT), durableObjects: { "bad-binding": "Counter" } }),
		).rejects.toThrow("Invalid binding name");
		expect((await stub.fetch("https://worker.test/")).status).toBe(201);
	});

	it("requires one valid public endpoint", () => {
		expect(
			() =>
				new Miniflare({
					...options(SCRIPT),
					endpoint: "not-a-url",
				}),
		).toThrow("endpoint must be an absolute HTTP URL");
	});

	it("maps transport failures to a retryable MiniflareError", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
		const mf = createMiniflare();
		await expect(mf.ready).rejects.toMatchObject({
			code: "api_unavailable",
			retryable: true,
		});
		await expect(mf.ready).rejects.toBeInstanceOf(MiniflareError);
	});
});

function createMiniflare(overrides: Partial<MiniflareOptions> = {}): Miniflare {
	return new Miniflare({ ...options(SCRIPT), ...overrides });
}

function options(script: string): MiniflareOptions {
	return {
		endpoint: "https://api.internal/v1",
		name: "counter",
		script,
		durableObjects: { COUNTER: "Counter" },
	};
}

function versionResource(id: string) {
	return {
		object: "version",
		id,
		worker: "counter",
		digest: id.slice(2),
		created_at: "2026-09-01T00:00:00Z",
		main_module: "main.js",
		module_count: 1,
		compatibility_date: "2026-08-14",
	};
}

function deploymentResource(versionId: string) {
	return {
		object: "deployment",
		id: deploymentID(versionId),
		worker: "counter",
		versions: [{ version_id: versionId, percentage: 100 }],
		deployed_at: "2026-09-01T00:00:01Z",
	};
}

function deploymentID(versionId: string): string {
	return `d_${versionId.slice(2, 34)}`;
}

function publicError(status: number, code: string, message: string): Response {
	return Response.json(
		{ error: { code, message, retryable: status >= 500, request_id: "req_test" } },
		{ status, headers: { "x-workers-error": "true" } },
	);
}

function objectID(): string {
	const hash = createHash("sha256");
	for (const part of ["counter", "Counter", "alice"]) {
		hash.update(part);
		hash.update("\0");
	}
	return hash.digest("hex");
}

function safeJSON(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}
