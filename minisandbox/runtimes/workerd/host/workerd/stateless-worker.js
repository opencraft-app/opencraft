const TOKEN_HEADER = "X-Rivet-Workerd-Token";
const WORKER_NAME_HEADER = "X-Rivet-Worker-Name";
const WORKER_VERSION_HEADER = "X-Rivet-Worker-Version";
const ORIGINAL_URL_HEADER = "X-Rivet-Original-URL";
const HEALTH_PATH = "/__rivet/healthz";
const PREPARE_PATH = "/__rivet/prepare";
const RUNTIME_STATS_PATH = "/__rivet/stateless-runtime-stats";
const WORKER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const WORKER_VERSION_PATTERN = /^v_[0-9a-f]{64}$/;
const loaderCaches = new WeakMap();

// These boundaries mirror engine/packages/metrics/src/buckets.rs::BUCKETS.
const COLD_START_BUCKETS = [
	0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
	1, 2.5, 5, 10, 25, 50, 100, 250, 500,
];

export class StatelessRuntimeMetrics {
	constructor({ now = Date.now } = {}) {
		this.now = now;
		this.started = 0;
		this.clockRegressions = 0;
		this.results = {
			ready: { count: 0, sum: 0, buckets: COLD_START_BUCKETS.map(() => 0) },
			failed: { count: 0, sum: 0, buckets: COLD_START_BUCKETS.map(() => 0) },
		};
	}

	begin() {
		this.started++;
		return this.now();
	}

	finish(startedAt, result) {
		const elapsedMs = this.now() - startedAt;
		if (elapsedMs < 0) this.clockRegressions++;
		const seconds = Math.max(0, elapsedMs) / 1000;
		const histogram = this.results[result];
		histogram.count++;
		histogram.sum += seconds;
		for (let i = 0; i < COLD_START_BUCKETS.length; i++) {
			if (seconds <= COLD_START_BUCKETS[i]) histogram.buckets[i]++;
		}
	}

	snapshot() {
		return {
			schemaVersion: "rivet-stateless-runtime-stats/v1",
			coldStarts: {
				started: this.started,
				clockRegressions: this.clockRegressions,
				bucketUpperBoundsSeconds: [...COLD_START_BUCKETS],
				results: {
					ready: { ...this.results.ready, buckets: [...this.results.ready.buckets] },
					failed: { ...this.results.failed, buckets: [...this.results.failed.buckets] },
				},
			},
		};
	}
}

// Only the native namespace owns WorkerStub references. Cross-request JS state
// tracks names, never IoOwn handles. unload() removes the named reference while
// native request channels retain their own references until requests finish.
export class StatelessIsolateCache {
	constructor(loader, { maxEntries = 16, idleTtlMs = 60000, now = Date.now } = {}) {
		if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 256) {
			throw new RangeError("stateless isolate cache capacity must be 1..256");
		}
		if (!Number.isInteger(idleTtlMs) || idleTtlMs < 1 || idleTtlMs > 3600000) {
			throw new RangeError("stateless isolate cache TTL must be 1..3600000 ms");
		}
		this.loader = loader;
		this.maxEntries = maxEntries;
		this.idleTtlMs = idleTtlMs;
		this.now = now;
		this.names = new Map();
		this.metrics = new StatelessRuntimeMetrics();
	}

	get size() {
		return this.names.size;
	}

	retire(name) {
		// A false result also means the namespace already dropped an aborted name.
		// If unloading throws, keep the entry and refuse admission, not the bound.
		this.loader.unload(name);
		this.names.delete(name);
	}

	touch(name) {
		const now = this.now();
		for (const [cachedName, usedAt] of this.names) {
			if (now - usedAt >= this.idleTtlMs) this.retire(cachedName);
		}
		if (this.names.has(name)) {
			this.names.delete(name);
		} else if (this.names.size >= this.maxEntries) {
			this.retire(this.names.keys().next().value);
		}
		this.names.set(name, now);
	}
}

function cacheSetting(value, fallback) {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
		throw new TypeError("invalid stateless isolate cache configuration");
	}
	return Number(value);
}

function loaderCache(env) {
	let cache = loaderCaches.get(env.WORKER_LOADER);
	if (cache === undefined) {
		cache = new StatelessIsolateCache(env.WORKER_LOADER, {
			maxEntries: cacheSetting(env.RIVET_STATELESS_ISOLATE_CACHE_CAPACITY, 16),
			idleTtlMs: cacheSetting(env.RIVET_STATELESS_ISOLATE_CACHE_IDLE_MS, 60000),
		});
		loaderCaches.set(env.WORKER_LOADER, cache);
	}
	return cache;
}

function authenticated(request, env) {
	const supplied = request.headers.get(TOKEN_HEADER);
	return supplied !== null && supplied === env.RIVET_WORKERD_TOKEN;
}

function workerReference(request) {
	const workerName = request.headers.get(WORKER_NAME_HEADER);
	const workerVersion = request.headers.get(WORKER_VERSION_HEADER);
	if (
		workerName === null ||
		workerVersion === null ||
		!WORKER_NAME_PATTERN.test(workerName) ||
		!WORKER_VERSION_PATTERN.test(workerVersion)
	) {
		throw new TypeError("missing or invalid Worker reference");
	}
	return { workerName, workerVersion };
}

function isolateName({ workerName, workerVersion }) {
	return `rivet-stateless-v1:${workerName}:${workerVersion}`;
}

function loadWorker(env, reference, ctx) {
	const name = isolateName(reference);
	const cache = loaderCache(env);
	cache.touch(name);
	let pendingWorker;
	const worker = env.WORKER_LOADER.get(name, async () => {
		// The native loader calls this only on actual startup, not on a JS name
		// table or Host code-cache miss. Concurrent hot callers do not count it.
		const startedAt = cache.metrics.begin();
		// Schedule after get() returns so this also works if a loader enters its
		// code callback synchronously. Clear the captured stub before awaiting
		// native readiness; the loader's callback must not root its own stub.
		const ready = Promise.resolve().then(() => {
			const initializingWorker = pendingWorker;
			pendingWorker = undefined;
			return initializingWorker.ready();
		});
		// Only a genuine cold load adds readiness observation. Hot requests do
		// not pay another native round trip or create a background task.
		ctx.waitUntil(ready.then(
			() => cache.metrics.finish(startedAt, "ready"),
			() => cache.metrics.finish(startedAt, "failed"),
		));
		const response = await env.WORKER_CODE.fetch(
			`http://worker-code/__rivet/stateless-worker-code/${reference.workerName}/${reference.workerVersion}`,
			{ headers: { [TOKEN_HEADER]: env.RIVET_WORKERD_TOKEN } },
		);
		if (!response.ok) throw new Error(`Worker code unavailable: ${response.status}`);
		const code = await response.json();
		if (code.env === undefined) code.env = {};
		if (code.env === null || typeof code.env !== "object" || Array.isArray(code.env)) {
			throw new TypeError("Worker code env must be an object");
		}
		code.env.__RIVET_OBJECT_ROUTER = env.OBJECT_ROUTER;
		code.env.__RIVET_OBJECT_ROUTER_TOKEN = env.RIVET_OBJECT_ROUTER_TOKEN;
		return code;
	});
	pendingWorker = worker;
	return worker;
}

function userRequest(request, ctx) {
	const originalUrl = request.headers.get(ORIGINAL_URL_HEADER);
	if (originalUrl === null || originalUrl.length > 8192) {
		throw new TypeError("missing or invalid original request URL");
	}
	const url = new URL(originalUrl);
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username !== "" ||
		url.password !== ""
	) {
		throw new TypeError("invalid original request URL");
	}
	// Tee before constructing the forwarded Request, which shares the body.
	// Drain only validated requests and preserve native fixed-length framing.
	if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
		ctx.waitUntil(
			request
				.clone()
				.arrayBuffer()
				.then(() => undefined),
		);
	}
	// Passing the original Request as RequestInit preserves workerd's fixed-length
	// body framing across the WorkerLoader boundary. Re-wrapping request.body as a
	// generic ReadableStream makes valid POSTs terminate the HTTP/1 connection.
	const forwarded = new Request(url, request);
	for (const name of [...forwarded.headers.keys()]) {
		if (name.toLowerCase().startsWith("x-rivet-")) forwarded.headers.delete(name);
	}
	return forwarded;
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (!authenticated(request, env)) return new Response("not found", { status: 404 });
		if (request.method === "GET" && url.pathname === HEALTH_PATH) {
			return new Response(null, { status: 204 });
		}
		if (url.pathname === RUNTIME_STATS_PATH) {
			if (request.method !== "GET") return new Response("not found", { status: 404 });
			return Response.json(loaderCache(env).metrics.snapshot(), {
				headers: { "Cache-Control": "no-store" },
			});
		}

		let reference;
		try {
			reference = workerReference(request);
		} catch {
			return Response.json({ code: "invalid_worker_reference" }, { status: 400 });
		}
		if (request.method === "POST" && url.pathname === PREPARE_PATH) {
			const worker = loadWorker(env, reference, ctx);
			await worker.ready();
			await worker.validateEntrypoint();
			return new Response(null, { status: 204 });
		}
		if (url.pathname.startsWith("/__rivet/")) {
			return new Response("not found", { status: 404 });
		}

		let forwarded;
		try {
			forwarded = userRequest(request, ctx);
		} catch {
			return Response.json({ code: "invalid_original_url" }, { status: 400 });
		}
		try {
			// Return the native response stream without JS lifetime wrappers.
			const worker = loadWorker(env, reference, ctx);
			return await worker.getEntrypoint().fetch(forwarded);
		} catch (error) {
			console.error("stateless Worker invocation failed", error);
			return Response.json({ code: "worker_invocation_failed" }, { status: 500 });
		}
	},
};
