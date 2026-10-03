import assert from "node:assert/strict";

function invoke(root, name, path = "/", body) {
	return root.fetch(
		new Request(`http://root${path}`, {
			method: body === undefined ? "GET" : "POST",
			body,
			headers: {
				"X-Rivet-Workerd-Token": "test-token",
				"X-Rivet-Worker-Name": name,
				"X-Rivet-Worker-Version": `v_${"1".repeat(64)}`,
				"X-Rivet-Original-URL": `https://user.example${path}`,
			},
		}),
	);
}

async function count(root, name) {
	const response = await invoke(root, name);
	assert.equal(response.status, 200);
	return (await response.json()).count;
}

export default {
	async test(_controller, env) {
		assert.equal(await count(env.ROOT, "alpha"), 1);
		assert.equal(await count(env.ROOT, "beta"), 1);
		assert.equal(await count(env.ROOT, "alpha"), 2);
		assert.equal(await count(env.ROOT, "gamma"), 1);
		assert.equal(await count(env.ROOT, "alpha"), 3);
		assert.equal(await count(env.ROOT, "beta"), 1);

		const response = await invoke(env.ROOT, "framing", "/echo?q=1", "fixed-body");
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			count: 1,
			url: "https://user.example/echo?q=1",
			body: "fixed-body",
			privateHeaders: [],
		});

		const stream = await invoke(env.ROOT, "streaming", "/stream");
		assert.equal(stream.status, 200);
		assert.equal(stream.headers.get("X-Counter"), "1");
		const reader = stream.body.getReader();
		const first = await reader.read();
		assert.equal(first.done, false);
		assert.equal(new TextDecoder().decode(first.value), "begin:");
		// Backpressure keeps the old request live while its namespace name is
		// evicted and a fresh same-name instance is loaded.
		assert.equal(await count(env.ROOT, "evict-one"), 1);
		assert.equal(await count(env.ROOT, "evict-two"), 1);
		assert.equal(await count(env.ROOT, "streaming"), 1);
		let tail = "";
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			tail += new TextDecoder().decode(next.value);
		}
		assert.equal(tail, `${"x".repeat(1024 * 1024)}:end`);
		assert.equal(await count(env.ROOT, "streaming"), 2);

		const cancelled = await invoke(env.ROOT, "cancelled", "/stream");
		const cancelledReader = cancelled.body.getReader();
		await cancelledReader.read();
		await count(env.ROOT, "cancel-evict-one");
		await count(env.ROOT, "cancel-evict-two");
		assert.equal(await count(env.ROOT, "cancelled"), 1);
		await cancelledReader.cancel();
		assert.equal(await count(env.ROOT, "cancelled"), 2);

		for (let i = 0; i < 100; i++) {
			assert.equal(await count(env.ROOT, `historical-${i}`), 1);
		}
		assert.equal(await count(env.ROOT, "historical-0"), 1);

		assert.equal(await count(env.TTL_ROOT, "idle"), 1);
		// This timer advances across the configured idle deadline. It is not a
		// retry or readiness poll; the Node suite covers the exact boundary.
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(await count(env.TTL_ROOT, "idle"), 1);
	},
};
