const TOKEN_HEADER = "X-Rivet-Workerd-Token";
const WORKER_NAME_HEADER = "X-Rivet-Worker-Name";
const WORKER_VERSION_HEADER = "X-Rivet-Worker-Version";
const ORIGINAL_URL_HEADER = "X-Rivet-Original-URL";
const HEALTH_PATH = "/__rivet/healthz";
const PREPARE_PATH = "/__rivet/prepare";
const WORKER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const WORKER_VERSION_PATTERN = /^v_[0-9a-f]{64}$/;
const loaderCaches = new WeakMap();

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

function loadWorker(env, reference) {
	const name = isolateName(reference);
	loaderCache(env).touch(name);
	return env.WORKER_LOADER.get(name, async () => {
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

		let reference;
		try {
			reference = workerReference(request);
		} catch {
			return Response.json({ code: "invalid_worker_reference" }, { status: 400 });
		}
		if (request.method === "POST" && url.pathname === PREPARE_PATH) {
			const worker = loadWorker(env, reference);
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
			const worker = loadWorker(env, reference);
			return await worker.getEntrypoint().fetch(forwarded);
		} catch (error) {
			console.error("stateless Worker invocation failed", error);
			return Response.json({ code: "worker_invocation_failed" }, { status: 500 });
		}
	},
};
