import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ACTOR_ID = "dispatch_regression";
const GENERATION = 3;
const VERSION = `v_${"1".repeat(64)}`;
const TOKEN = "local-dispatch-test-only";
const CLASS_NAME = "WebsiteActor";
const WORKER_URL = new URL("../workerd/worker.js", import.meta.url);

function harness({ codeStatus = 200, actorMetadata, codeGate, enforceRequestContext = false } = {}) {
	let requestContext = 0;
	function currentRequest(owner) {
		if (enforceRequestContext && owner !== requestContext) throw new Error("Cannot perform I/O on behalf of a different request");
	}
	const events = [];
	const containers = new Map();
	const isolates = new Map();
	const context = vm.createContext({
		URL, Request, Response, Headers, TextEncoder,
		DurableObject: class {}, RpcTarget: class {},
	});
	const script = readFileSync(WORKER_URL, "utf8")
		.replace('import unsafe from "workerd:unsafe";', "const unsafe = testUnsafe;")
		.replace('import { DurableObject, RpcTarget } from "cloudflare:workers";', "")
		.replace("export default {", "const gateway = {")
		.replace("export class RivetActor", "class RivetActor");

	// Model the pinned native findOrCreate: the FIRST channel resolution fixes
	// the container class, and subsequent class overrides are ignored, even
	// after eviction. Resolving an eviction channel can create an idle container.
	function containerFor(id, actorClass) {
		if (!containers.has(id)) {
			containers.set(id, { actorClass: actorClass ?? "fixture", running: false, count: 0 });
			events.push(`container:${actorClass?.name ?? "fixture"}`);
		}
		return containers.get(id);
	}
	context.testUnsafe = {
		async evict(stub) {
			currentRequest(stub.requestOwner);
			const container = containerFor(stub.id, stub.actorClass);
			events.push("evict");
			if (!container.running) throw new Error("it is not currently running");
			container.running = false;
		},
	};
	const { gateway, RivetActor } = new vm.Script(`${script}
({ gateway, RivetActor });`, {
		filename: WORKER_URL.pathname,
	}).runInContext(context);
	const env = {
		RIVET_WORKERD_TOKEN: TOKEN,
		WORKER_CODE: {
			async fetch(url, init) {
				assert.equal(url, `http://worker-code/__rivet/worker-code/${ACTOR_ID}/${GENERATION}`);
				assert.equal(init.headers["X-Rivet-Workerd-Token"], TOKEN);
				events.push("code");
				if (codeGate !== undefined) await codeGate;
				if (codeStatus !== 200) return new Response(null, { status: codeStatus });
				return Response.json({
					env: { RIVET_ACTOR: actorMetadata ?? {
						id: ACTOR_ID, generation: GENERATION, durableObjectClass: CLASS_NAME,
					} },
				});
			},
		},
		WORKER_LOADER: {
			get(id, factory) {
				if (!isolates.has(id)) {
					let loaded;
					const ready = () => loaded ??= factory();
					isolates.set(id, {
						ready,
						validateEntrypoint: async () => { await ready(); },
						validateDurableObjectClass: async (name) => {
							await ready();
							assert.equal(name, CLASS_NAME);
						},
						getDurableObjectClass: (name) => ({ name, ready }),
						getEntrypoint: () => ({ fetch: async () => {
							await ready();
							return Response.json({ implementation: "user-default" });
						} }),
					});
				}
				const owner = requestContext;
				const isolate = isolates.get(id);
				return {
					ready: () => { currentRequest(owner); return isolate.ready(); },
					validateEntrypoint: () => { currentRequest(owner); return isolate.validateEntrypoint(); },
					validateDurableObjectClass: (name) => { currentRequest(owner); return isolate.validateDurableObjectClass(name); },
					getDurableObjectClass: (name) => { currentRequest(owner); return isolate.getDurableObjectClass(name); },
					getEntrypoint: () => { currentRequest(owner); return isolate.getEntrypoint(); },
				};
			},
			unload(id) {
				events.push("unload");
				isolates.delete(id);
			},
		},
		ACTOR: {
			idFromName: (name) => name,
			get(id, options) {
				const owner = requestContext;
				events.push(`stub:${options?.rivetClass?.name ?? "fixture"}`);
				return {
					id, actorClass: options?.rivetClass, requestOwner: owner,
					async fetch(request) {
						currentRequest(owner);
						const container = containerFor(id, options?.rivetClass);
						if (container.actorClass !== "fixture") {
							await container.actorClass.ready();
							container.running = true;
							return Response.json({ implementation: container.actorClass.name });
						}
						if (!container.instance || !container.running) {
							const sql = { exec(query) {
								if (query.startsWith("INSERT INTO counters")) container.count++;
								return { one: () => query.includes("SELECT COUNT(*)")
									? { chunks: 0, bytes: 0 } : { count: container.count } };
							} };
							container.instance = new RivetActor({ id: { name: id }, storage: { sql } }, {});
						}
						container.running = true;
						return container.instance.fetch(request);
					},
				};
			},
		},
	};
	async function request(path, { method = "GET", worker = false, className, headers = {} } = {}) {
		requestContext++;
		const identityHeaders = {
			"X-Rivet-Actor-Id": ACTOR_ID,
			"X-Rivet-Actor-Generation": String(GENERATION),
			"X-Rivet-Workerd-Token": TOKEN,
			...headers,
		};
		if (worker) {
			identityHeaders["X-Rivet-Worker-Name"] = "website-worker";
			identityHeaders["X-Rivet-Worker-Version"] = VERSION;
		}
		if (className !== undefined) identityHeaders["X-Rivet-Durable-Object-Class"] = className;
		Object.assign(identityHeaders, headers);
		return gateway.fetch(new Request(`http://local.test${path}`, { method, headers: identityHeaders }), env, {
			waitUntil: () => {},
		});
	}
	return { request, events, containers, setCodeStatus: (status) => { codeStatus = status; } };
}

async function userFetch(h) {
	const response = await h.request("/api/todos", { worker: true, className: CLASS_NAME });
	assert.equal(response.status, 200);
	assert.equal((await response.json()).implementation, CLASS_NAME);
}

test("unknown and prepared-only eviction cannot create a native fixture container", async () => {
	const h = harness();
	assert.equal((await h.request("/__rivet/evict", { method: "POST" })).status, 204);
	assert.equal(h.events.filter((event) => event === "code").length, 0);
	assert.equal((await h.request("/__rivet/prepare", {
		method: "POST", worker: true, className: CLASS_NAME,
	})).status, 204);
	assert.equal((await h.request("/__rivet/evict", { method: "POST" })).status, 204);
	assert.equal(h.containers.size, 0);
	assert.ok(!h.events.includes("evict"));
	assert.ok(!h.events.some((event) => event.startsWith("stub:")));
	await userFetch(h);
	assert.equal(h.containers.values().next().value.actorClass.name, CLASS_NAME);
});

test("fenced metadata unavailable still evicts with the cached user class", async () => {
	const h = harness();
	await userFetch(h);
	assert.equal((await h.request("/api/todos", { worker: true })).status, 409);
	h.setCodeStatus(404);
	const before = h.events.length;
	assert.equal((await h.request("/__rivet/evict", { method: "POST" })).status, 204);
	assert.deepEqual(h.events.slice(before), ["stub:WebsiteActor", "evict", "unload"]);
	h.setCodeStatus(200);
	await userFetch(h);
	assert.ok(!h.events.includes("stub:fixture"));
});

test("stateless eviction only unloads and never resolves a native DO channel", async () => {
	const h = harness({ actorMetadata: { id: ACTOR_ID, generation: GENERATION } });
	const response = await h.request("/api/todos", { worker: true });
	assert.equal((await response.json()).implementation, "user-default");
	h.setCodeStatus(404);
	const before = h.events.length;
	assert.equal((await h.request("/__rivet/evict", { method: "POST" })).status, 204);
	assert.deepEqual(h.events.slice(before), ["unload"]);
	assert.equal(h.containers.size, 0);
});

test("cold dispatch validates the trusted class before native container selection", async () => {
	const h = harness({ actorMetadata: {
		id: ACTOR_ID, generation: GENERATION, durableObjectClass: "OtherActor",
	} });
	await assert.rejects(userFetch(h), /does not match dispatch/);
	assert.equal(h.containers.size, 0);
	assert.ok(!h.events.some((event) => event.startsWith("stub:")));
});

test("missing worker identity on unknown business paths cannot return fixture success", async () => {
	const h = harness();
	for (const path of ["/api/todos", "/__platform_prepare", "/unknown-business"]) {
		const response = await h.request(path);
		assert.equal(response.status, 400);
		assert.equal((await response.json()).code, "missing_worker_reference");
	}
	const originalBusiness = await h.request("/", {
		headers: { "X-Rivet-Original-URL": "https://local.test/api/todos" },
	});
	assert.equal(originalBusiness.status, 400);
	assert.equal((await originalBusiness.json()).code, "missing_worker_reference");
	assert.equal(h.containers.size, 0);
});

test("failed activation leaves eviction unload-only without cold fixture selection", async () => {
	for (const options of [
		{ codeStatus: 404 },
		{ actorMetadata: { id: "other_actor", generation: GENERATION, durableObjectClass: CLASS_NAME } },
		{ actorMetadata: { id: ACTOR_ID, generation: GENERATION, durableObjectClass: "bad-name" } },
	]) {
		const h = harness(options);
		await assert.rejects(h.request("/__rivet/prepare", {
			method: "POST", worker: true, className: CLASS_NAME,
		}));
		const before = h.events.length;
		assert.equal((await h.request("/__rivet/evict", { method: "POST" })).status, 204);
		assert.deepEqual(h.events.slice(before), ["unload"]);
		assert.equal(h.containers.size, 0);
	}
});

test("legacy explicit fixture paths retain count and eviction without business fallback", async () => {
	const h = harness();
	const increment = await h.request("/increment", { method: "POST" });
	assert.equal(increment.status, 200);
	assert.equal((await increment.json()).count, 1);
	const before = h.events.length;
	assert.equal((await h.request("/__rivet/evict", { method: "POST" })).status, 204);
	assert.deepEqual(h.events.slice(before), ["stub:fixture", "evict", "unload"]);
	const state = await h.request("/");
	assert.equal(state.status, 200);
	assert.equal((await state.json()).count, 1);
	assert.equal((await h.request("/bottomless-verify")).status, 200);
	assert.equal((await h.request("/api/todos")).status, 400);
	assert.equal((await h.request("/", { className: CLASS_NAME })).status, 400);
	assert.equal((await h.request("/api/todos", { worker: true, className: CLASS_NAME })).status, 409);
	assert.equal((await h.request("/__rivet/prepare", { method: "POST", worker: true, className: CLASS_NAME })).status, 409);
});

// A fence must not wait for an untrusted/pending activation or let it dispatch late.
test("pending activation eviction is bounded and cannot later select a native channel", async () => {
	for (const path of ["/__rivet/prepare", "/api/records"]) {
		let release;
		const codeGate = new Promise((resolve) => { release = resolve; });
		const h = harness({ codeGate });
		const pending = h.request(path, { method: path.endsWith("prepare") ? "POST" : "GET", worker: true, className: CLASS_NAME });
		await new Promise((resolve) => setImmediate(resolve));
		let timer;
		const evicted = await Promise.race([
			h.request("/__rivet/evict", { method: "POST" }),
			new Promise((resolve) => { timer = setTimeout(() => resolve(null), 100); }),
		]);
		clearTimeout(timer);
		release();
		const resumed = await pending;
		assert.equal(evicted?.status, 204, "eviction must not await suspended code preparation");
		assert.equal(resumed.status, 409, "the fenced activation must not resume dispatch");
		assert.equal(h.containers.size, 0);
		assert.ok(!h.events.some((event) => event.startsWith("stub:")));
	}
});

// Real pinned workerd rejects request-owned Worker/DO handles retained in module globals.
test("repeated dispatch and fenced eviction recreate request-local handles", async () => {
	const h = harness({ enforceRequestContext: true });
	await userFetch(h);
	await userFetch(h);
	h.setCodeStatus(404);
	assert.equal((await h.request("/__rivet/evict", { method: "POST" })).status, 204);
	h.setCodeStatus(200);
	await userFetch(h);
});

test("a generation cannot change its worker version after native eviction", async () => {
	const h = harness();
	await userFetch(h);
	assert.equal((await h.request("/__rivet/evict", { method: "POST" })).status, 204);
	const response = await h.request("/__rivet/prepare", {
		method: "POST", worker: true, className: CLASS_NAME,
		headers: { "X-Rivet-Worker-Version": `v_${"2".repeat(64)}` },
	});
	assert.equal(response.status, 409);
	assert.equal((await response.json()).code, "actor_binding_mismatch");
});
