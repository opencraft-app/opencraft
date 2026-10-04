import assert from "node:assert/strict";

const version = `v_${"1".repeat(64)}`;
const statsPath = "http://root/__rivet/stateless-runtime-stats";

function invoke(root, name, path = "/", method = "GET") {
	return root.fetch(new Request(`http://root${path}`, {
		method,
		headers: {
			"X-Rivet-Workerd-Token": "test-token",
			"X-Rivet-Worker-Name": name,
			"X-Rivet-Worker-Version": version,
			"X-Rivet-Original-URL": `https://user.example${path}`,
		},
	}));
}

async function stats(root) {
	const response = await root.fetch(statsPath, {
		headers: { "X-Rivet-Workerd-Token": "test-token" },
	});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const snapshot = await response.json();
	assert.equal(snapshot.schemaVersion, "rivet-stateless-runtime-stats/v1");
	assert.deepEqual(Object.keys(snapshot).sort(), ["coldStarts", "schemaVersion"]);
	assert.deepEqual(Object.keys(snapshot.coldStarts.results).sort(), ["failed", "ready"]);
	for (const histogram of Object.values(snapshot.coldStarts.results)) {
		assert.equal(histogram.buckets.length, snapshot.coldStarts.bucketUpperBoundsSeconds.length);
		assert.ok(histogram.sum >= 0);
		assert.ok(histogram.buckets.every((value) => value <= histogram.count));
		assert.ok(histogram.buckets.every((value, i) => i === 0 || value >= histogram.buckets[i - 1]));
	}
	return snapshot.coldStarts;
}

export default {
	async test(_controller, env) {
		assert.equal((await env.ROOT.fetch(statsPath)).status, 404);
		assert.equal((await env.ROOT.fetch(statsPath, {
			headers: { "X-Rivet-Workerd-Token": "wrong-token" },
		})).status, 404);
		const empty = await stats(env.ROOT);
		assert.equal(empty.started, 0);
		assert.equal(empty.results.ready.count, 0);
		assert.equal(empty.results.failed.count, 0);
		assert.equal((await env.ROOT.fetch(statsPath, {
			method: "POST", headers: { "X-Rivet-Workerd-Token": "test-token" },
		})).status, 404);
		assert.deepEqual(await stats(env.ROOT), empty);

		assert.equal((await invoke(env.ROOT, "alpha", "/__rivet/prepare", "POST")).status, 204);
		assert.equal((await stats(env.ROOT)).started, 1);
		assert.equal((await invoke(env.ROOT, "alpha", "/__rivet/prepare", "POST")).status, 204);
		const hot = await invoke(env.ROOT, "alpha");
		assert.equal((await hot.json()).count, 1);
		const reused = await stats(env.ROOT);
		assert.equal(reused.started, 1);
		assert.equal(reused.results.ready.count, 1);

		const concurrent = await Promise.all(Array.from({ length: 20 }, async () => {
			const response = await invoke(env.ROOT, "concurrent");
			assert.equal(response.status, 200);
			return (await response.json()).count;
		}));
		assert.deepEqual(concurrent.sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
		assert.equal((await stats(env.ROOT)).started, 2);
		assert.equal((await stats(env.ROOT)).results.ready.count, 2);

		await (await invoke(env.ROOT, "gamma")).arrayBuffer();
		assert.equal((await invoke(env.ROOT, "alpha", "/__rivet/prepare", "POST")).status, 204);
		assert.equal((await stats(env.ROOT)).started, 4);
		assert.equal((await stats(env.ROOT)).results.ready.count, 4);

		for (const name of ["bad-syntax", "missing-default", "code-unavailable"]) {
			const before = await stats(env.ROOT);
			const response = await invoke(env.ROOT, name);
			assert.equal(response.status, 500);
			assert.deepEqual(await response.json(), { code: "worker_invocation_failed" });
			const after = await stats(env.ROOT);
			assert.equal(after.started, before.started + 1);
			assert.equal(after.results.failed.count, before.results.failed.count + 1);
			assert.equal(after.results.ready.count, before.results.ready.count);
			// A cached failed native stub is not another cold start.
			await (await invoke(env.ROOT, name)).arrayBuffer();
			assert.deepEqual(await stats(env.ROOT), after);
		}

		const beforeUserError = await stats(env.ROOT);
		const userError = await invoke(env.ROOT, "user-error", "/throw");
		assert.equal(userError.status, 500);
		await userError.arrayBuffer();
		const afterUserError = await stats(env.ROOT);
		assert.equal(afterUserError.started, beforeUserError.started + 1);
		assert.equal(afterUserError.results.ready.count, beforeUserError.results.ready.count + 1);
		assert.equal(afterUserError.results.failed.count, beforeUserError.results.failed.count);
		assert.equal(afterUserError.started, afterUserError.results.ready.count + afterUserError.results.failed.count);
	},
};
