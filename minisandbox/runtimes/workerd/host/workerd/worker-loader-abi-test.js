import assert from "node:assert";

const OBJECT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OBJECT_ROUTER_TOKEN = "worker-loader-abi-object-router-token";

const wrapperModule = `
	import user from "./user.js";

	const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
	const ORIGINAL_URL_HEADER = "X-Rivet-Original-URL";
	const ROUTER_TOKEN_HEADER = "X-Rivet-Object-Router-Token";

	class DurableObjectId {
		#namespace;
		#value;

		constructor(namespace, value) {
			this.#namespace = namespace;
			this.#value = value;
			Object.freeze(this);
		}

		belongsTo(namespace) {
			return this.#namespace === namespace;
		}

		toString() {
			return this.#value;
		}
	}

	class DurableObjectStub {
		#className;
		#id;
		#router;
		#token;
		#worker;

		constructor(router, token, worker, className, id) {
			this.#router = router;
			this.#token = token;
			this.#worker = worker;
			this.#className = className;
			this.#id = id;
			Object.freeze(this);
		}

		async fetch(input, init) {
			const request = new Request(input, init);
			const headers = new Headers(request.headers);
			headers.set(ORIGINAL_URL_HEADER, request.url);
			headers.set(ROUTER_TOKEN_HEADER, this.#token);
			const target = new URL(
				"http://object-router/internal/v1/workers/" +
					encodeURIComponent(this.#worker) + "/objects/" +
					encodeURIComponent(this.#className) + "/" +
					encodeURIComponent(this.#id.toString()) + "/fetch",
			);
			return this.#router.fetch(new Request(target, {
				method: request.method,
				headers,
				body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
				redirect: "manual",
			}));
		}
	}

	class DurableObjectNamespace {
		#className;
		#router;
		#token;
		#worker;

		constructor(router, token, worker, className) {
			this.#router = router;
			this.#token = token;
			this.#worker = worker;
			this.#className = className;
			Object.freeze(this);
		}

		idFromString(value) {
			if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
				throw new TypeError("Durable Object ID must contain 64 lowercase hexadecimal characters");
			}
			return new DurableObjectId(this, value);
		}

		get(id) {
			if (!(id instanceof DurableObjectId) || !id.belongsTo(this)) {
				throw new TypeError("Durable Object ID belongs to another namespace");
			}
			return new DurableObjectStub(
				this.#router,
				this.#token,
				this.#worker,
				this.#className,
				id,
			);
		}
	}

	export default {
		fetch(request, internalEnv, ctx) {
			const env = Object.freeze({
				COUNTER: new DurableObjectNamespace(
					internalEnv.__RIVET_OBJECT_ROUTER,
					internalEnv.__RIVET_OBJECT_ROUTER_TOKEN,
					"counter",
					"Counter",
				),
			});
			return user.fetch(request, env, ctx);
		},
	};
`;

export default {
	async test(_controller, env) {
		const worker = env.WORKER_LOADER.load({
			compatibilityDate: "2026-08-14",
			mainModule: "worker.js",
			modules: {
				"worker.js": `
					import {DurableObject} from "cloudflare:workers";
					export default { fetch() { return new Response("ready"); } };
					export class Counter extends DurableObject {}
				`,
			},
		});

		await worker.ready();
		await worker.validateEntrypoint();
		await worker.validateDurableObjectClass("Counter");
		await assert.rejects(
			worker.validateEntrypoint("missing"),
			/no such entrypoint: missing/,
		);
		await assert.rejects(
			worker.validateDurableObjectClass("missing"),
			/no such Durable Object class: missing/,
		);

		// A trusted wrapper, rather than user code, receives the internal Fetcher.
		// It exposes only a namespace capability and preserves the original URL.
		const routedWorker = env.WORKER_LOADER.load({
			compatibilityDate: "2026-08-14",
			mainModule: "wrapper.js",
			modules: {
				"wrapper.js": wrapperModule,
				"user.js": `
					export default {
						fetch(request, env) {
							if (Object.keys(env).join(",") !== "COUNTER") {
								throw new Error("internal Object Router capability leaked to user code");
							}
							const id = env.COUNTER.idFromString("${OBJECT_ID}");
							return env.COUNTER.get(id).fetch(request);
						},
					};
				`,
			},
			env: {
				__RIVET_OBJECT_ROUTER: env.OBJECT_ROUTER,
				__RIVET_OBJECT_ROUTER_TOKEN: OBJECT_ROUTER_TOKEN,
			},
		});
		await routedWorker.ready();
		await routedWorker.validateEntrypoint();
		const response = await routedWorker
			.getEntrypoint()
			.fetch(new Request("https://example.com/chat?turn=1", { method: "POST", body: "hello" }));
		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(await response.json(), {
			body: "hello",
			className: "Counter",
			method: "POST",
			objectId: OBJECT_ID,
			originalUrl: "https://example.com/chat?turn=1",
			worker: "counter",
		});
	},
};
