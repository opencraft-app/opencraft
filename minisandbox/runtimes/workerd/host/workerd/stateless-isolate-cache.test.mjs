import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = `${readFileSync(new URL("./stateless-worker.js", import.meta.url), "utf8")}\n//# sourceURL=stateless-worker-under-test.js`;
const module = await import(
	`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const { StatelessIsolateCache } = module;

function fixture(maxEntries = 2, idleTtlMs = 100) {
	let clock = 0;
	const removed = [];
	const named = new Map();
	const loader = {
		unload(name) {
			removed.push(name);
			return named.delete(name);
		},
		get(name) {
			if (!named.has(name)) named.set(name, {});
			return named.get(name);
		},
	};
	const cache = new StatelessIsolateCache(loader, { maxEntries, idleTtlMs, now: () => clock });
	return {
		cache,
		removed,
		named,
		loader,
		time(value) {
			clock = value;
		},
		get(name) {
			cache.touch(name);
			return loader.get(name);
		},
	};
}

test("LRU retires the native namespace name, not just JS bookkeeping", () => {
	const f = fixture();
	const a = f.get("a");
	f.get("b");
	assert.equal(f.get("a"), a);
	f.get("c");
	assert.deepEqual(f.removed, ["b"]);
	assert.deepEqual([...f.named.keys()], ["a", "c"]);
	assert.equal(f.cache.size, 2);
});

test("idle TTL expires exactly at the boundary and hot access refreshes it", () => {
	const f = fixture();
	const a = f.get("a");
	f.time(99);
	assert.equal(f.get("a"), a);
	f.time(198);
	f.get("b");
	assert.deepEqual(f.removed, []);
	f.time(199);
	assert.notEqual(f.get("a"), a);
	assert.deepEqual(f.removed, ["a"]);
});

test("historical names cannot grow either table, even when the clock moves backwards", () => {
	const f = fixture(16);
	for (let i = 0; i < 10000; i++) {
		f.time(-i);
		f.get(`version-${i}`);
		assert.ok(f.cache.size <= 16);
		assert.ok(f.named.size <= 16);
	}
	assert.equal(f.removed.length, 9984);
});

test("native unload failure fails closed instead of admitting another name", () => {
	const f = fixture(1);
	f.get("a");
	f.loader.unload = () => {
		throw new Error("unload unavailable");
	};
	assert.throws(() => f.get("b"), /unload unavailable/);
	assert.equal(f.cache.size, 1);
	assert.deepEqual([...f.named.keys()], ["a"]);
});

test("already-aborted native names are safe to retire", () => {
	const f = fixture(1);
	f.get("a");
	f.named.delete("a");
	f.get("b");
	assert.equal(f.cache.size, 1);
	assert.deepEqual([...f.named.keys()], ["b"]);
});

test("configuration cannot disable the bound or allocate an unbounded sweep", () => {
	for (const maxEntries of [0, -1, 1.5, Infinity, NaN, 257]) {
		assert.throws(() => fixture(maxEntries), /capacity/);
	}
	for (const idleTtlMs of [0, -1, 0.5, Infinity, NaN, 3600001]) {
		assert.throws(() => fixture(2, idleTtlMs), /TTL/);
	}
});

test("independent loader namespaces never evict each other's names", () => {
	const a = fixture(1);
	const b = fixture(1);
	const original = b.get("same");
	a.get("same");
	a.get("other");
	assert.equal(b.get("same"), original);
	assert.deepEqual(b.removed, []);
});

test("unauthenticated and reserved routes cannot load or evict Worker names", async () => {
	const env = {
		RIVET_WORKERD_TOKEN: "trusted-root-token",
		WORKER_LOADER: {
			get() {
				throw new Error("unexpected native load");
			},
			unload() {
				throw new Error("unexpected native unload");
			},
		},
	};
	assert.equal((await module.default.fetch(new Request("http://root/"), env, {})).status, 404);
	const headers = {
		"X-Rivet-Workerd-Token": env.RIVET_WORKERD_TOKEN,
		"X-Rivet-Worker-Name": "example",
		"X-Rivet-Worker-Version": `v_${"1".repeat(64)}`,
	};
	assert.equal(
		(await module.default.fetch(new Request("http://root/__rivet/unknown", { headers }), env, {}))
			.status,
		404,
	);
	assert.equal(
		(await module.default.fetch(new Request("http://root/", { headers }), env, {})).status,
		400,
	);
});

test("malformed trusted bindings fail before a native name is admitted", async () => {
	for (const capacity of ["0", "257", "1.5", "1e2", "", " 2", "999999999999999999999"]) {
		const env = {
			RIVET_WORKERD_TOKEN: "test-token",
			RIVET_STATELESS_ISOLATE_CACHE_CAPACITY: capacity,
			WORKER_LOADER: {
				get() {
					assert.fail("invalid configuration admitted a name");
				},
			},
		};
		const response = await module.default.fetch(
			new Request("http://root/", {
				headers: {
					"X-Rivet-Workerd-Token": "test-token",
					"X-Rivet-Worker-Name": "example",
					"X-Rivet-Worker-Version": `v_${"1".repeat(64)}`,
					"X-Rivet-Original-URL": "https://example.com/",
				},
			}),
			env,
			{},
		);
		assert.equal(response.status, 500);
	}
});
