import unsafe from "workerd:unsafe";
import { DurableObject, RpcTarget } from "cloudflare:workers";

const ACTOR_ID_HEADER = "X-Rivet-Actor-Id";
const GENERATION_HEADER = "X-Rivet-Actor-Generation";
const TOKEN_HEADER = "X-Rivet-Workerd-Token";
const WORKER_NAME_HEADER = "X-Rivet-Worker-Name";
const WORKER_VERSION_HEADER = "X-Rivet-Worker-Version";
const DURABLE_OBJECT_CLASS_HEADER = "X-Rivet-Durable-Object-Class";
const ORIGINAL_URL_HEADER = "X-Rivet-Original-URL";
const MANAGEMENT_PREFIX = "/__rivet/";
const EVICT_PATH = "/__rivet/evict";
const HEALTH_PATH = "/__rivet/healthz";
const PREPARE_PATH = "/__rivet/prepare";
// Cache plain activation metadata/code only: Worker and DO handles belong to
// one request. Retain the generation binding after eviction because native
// containers keep their first class, even after the running instance is evicted.
// Cleanup cannot consult the host registry after its admission fence removes it.
const activations = new Map();
// Qualification identities must not later be reused for user code while the
// native container can retain its original class. Keep this private set bounded.
const MAX_FIXTURE_IDENTITIES = 4096;
const fixtureIdentities = new Set();
const ACTOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const WORKER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const WORKER_VERSION_PATTERN = /^v_[0-9a-f]{64}$/;
const DURABLE_OBJECT_CLASS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const MAX_QUALIFICATION_CHUNK_BYTES = 256 * 1024;
// Destructive cold-tier qualification uses up to 256 MiB without putting one giant value in a
// single SQLite row. This endpoint is only present in the qualification fixture.
const MAX_QUALIFICATION_CHUNKS = 1024;
const MAX_QUALIFICATION_CHUNKS_PER_WRITE = 4;
const MAX_SQL_QUERY_BYTES = 64 * 1024;
const MAX_SQL_BINDINGS = 256;
const MAX_SQL_BINDING_BYTES = 1024 * 1024;
const MAX_SQL_RESULT_ROWS = 1000;
const MAX_SQL_RESULT_BYTES = 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();

function authenticated(request, env) {
	const supplied = request.headers.get(TOKEN_HEADER);
	return supplied !== null && supplied === env.RIVET_WORKERD_TOKEN;
}

function requestIdentity(request) {
	const actorId = request.headers.get(ACTOR_ID_HEADER);
	const generation = Number(request.headers.get(GENERATION_HEADER));
	if (
		!actorId ||
		!ACTOR_ID_PATTERN.test(actorId) ||
		!Number.isInteger(generation) ||
		generation <= 0 ||
		generation > 0xffff_ffff
	) {
		throw new TypeError("missing or invalid Rivet actor identity");
	}
	return { actorId, generation };
}

function isolateName({ actorId, generation }) {
	return `rivet-v1:${generation}:${actorId}`;
}

function workerReference(request) {
	const workerName = request.headers.get(WORKER_NAME_HEADER);
	const workerVersion = request.headers.get(WORKER_VERSION_HEADER);
	if ((workerName === null) !== (workerVersion === null)) {
		throw new TypeError("incomplete Worker reference");
	}
	if (
		workerName !== null &&
		(!WORKER_NAME_PATTERN.test(workerName) || !WORKER_VERSION_PATTERN.test(workerVersion))
	) {
		throw new TypeError("invalid Worker reference");
	}
	return workerName === null ? null : { workerName, workerVersion };
}

async function actorWorkerCode(env, identity) {
	const response = await env.WORKER_CODE.fetch(
		`http://worker-code/__rivet/worker-code/${identity.actorId}/${identity.generation}`,
		{ headers: { [TOKEN_HEADER]: env.RIVET_WORKERD_TOKEN } },
	);
	if (!response.ok) throw new Error(`Worker code unavailable: ${response.status}`);
	const code = await response.json();
	const actor = code?.env?.RIVET_ACTOR;
	if (
		code?.env === null ||
		typeof code?.env !== "object" ||
		Array.isArray(code.env) ||
		actor === null ||
		typeof actor !== "object" ||
		Array.isArray(actor) ||
		actor.id !== identity.actorId ||
		actor.generation !== identity.generation
	) {
		throw new TypeError("Worker code is missing its exact actor binding");
	}
	if (
		actor.durableObjectClass !== undefined &&
		(typeof actor.durableObjectClass !== "string" ||
			!DURABLE_OBJECT_CLASS_PATTERN.test(actor.durableObjectClass))
	) {
		throw new TypeError("Worker code has an invalid Durable Object class");
	}
	return code;
}

function loadWorker(env, identity, durableObjectClass = null, activation = null) {
	return env.WORKER_LOADER.get(isolateName(identity), async () => {
		const code = activation?.code ?? await actorWorkerCode(env, identity);
		if ((code.env.RIVET_ACTOR.durableObjectClass ?? null) !== durableObjectClass) {
			throw new TypeError("Worker code Durable Object class does not match dispatch");
		}
		if (activation !== null) activation.code = code;
		// Keep request-owned storage handles out of the retained code recipe.
		const loaded = { ...code, env: { ...code.env } };
		if (durableObjectClass === null) {
			loaded.env.RIVET_STORAGE = env.ACTOR.get(env.ACTOR.idFromName(isolateName(identity)));
		}
		return loaded;
	});
}

async function activateWorker(env, identity, reference, className) {
	const name = isolateName(identity);
	let activation = activations.get(name);
	if (activation !== undefined && (
		activation.active === false ||
		activation.workerName !== reference.workerName ||
		activation.workerVersion !== reference.workerVersion ||
		activation.className !== className
	)) return null;
	if (activation === undefined) {
		activation = { ...reference, className, code: null, active: true, epoch: 0, dispatched: false, validated: false };
		activations.set(name, activation);
	}
	const epoch = activation.epoch;
	// WorkerLoader reuses native code by name, but its JS handle must be freshly
	// obtained in this request, never stored in module-global activation state.
	const worker = loadWorker(env, identity, className, activation);
	try {
		await worker.ready();
		if (className !== null) await worker.validateDurableObjectClass(className);
		if (activation.active === false || activation.epoch !== epoch || activations.get(name) !== activation) return null;
		activation.validated = true;
		return { worker, record: activation };
	} catch (error) {
		if (!activation.validated && activations.get(name) === activation) activations.delete(name);
		throw error;
	}
}

function durableObjectClass(request) {
	const className = request.headers.get(DURABLE_OBJECT_CLASS_HEADER);
	if (className !== null && !DURABLE_OBJECT_CLASS_PATTERN.test(className)) {
		throw new TypeError("invalid Durable Object class");
	}
	return className;
}

function userRequest(request, headers) {
	const originalUrl = headers.get(ORIGINAL_URL_HEADER);
	headers.delete(ORIGINAL_URL_HEADER);
	if (originalUrl === null) return new Request(request, { headers });
	if (originalUrl.length > 8192) throw new TypeError("original request URL is too long");
	const url = new URL(originalUrl);
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username !== "" ||
		url.password !== ""
	) {
		throw new TypeError("invalid original request URL");
	}
	const forwarded = new Request(url, request);
	for (const [name, value] of headers) forwarded.headers.set(name, value);
	for (const name of [...forwarded.headers.keys()]) {
		if (!headers.has(name)) forwarded.headers.delete(name);
	}
	return forwarded;
}

function normalizeSqlBindings(bindings) {
	if (!Array.isArray(bindings) || bindings.length > MAX_SQL_BINDINGS) {
		throw new TypeError(`SQL bindings must be an array of at most ${MAX_SQL_BINDINGS} values`);
	}
	let totalBytes = 0;
	return bindings.map((value) => {
		if (value === null) return null;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) throw new TypeError("SQL number bindings must be finite");
			return value;
		}
		if (typeof value === "string") {
			totalBytes += UTF8_ENCODER.encode(value).byteLength;
		} else if (value instanceof ArrayBuffer) {
			totalBytes += value.byteLength;
		} else if (ArrayBuffer.isView(value)) {
			totalBytes += value.byteLength;
			value = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
		} else {
			throw new TypeError("SQL bindings support only null, finite numbers, strings, and bytes");
		}
		if (totalBytes > MAX_SQL_BINDING_BYTES) {
			throw new RangeError(`SQL bindings exceed ${MAX_SQL_BINDING_BYTES} bytes`);
		}
		return value;
	});
}

function sqlValueBytes(value) {
	if (value === null || typeof value === "number") return 8;
	if (typeof value === "string") return UTF8_ENCODER.encode(value).byteLength;
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
	throw new TypeError("SQLite returned an unsupported value type");
}

class RivetSqlCapability extends RpcTarget {
	#actorSql;

	constructor(sql) {
		super();
		this.#actorSql = sql;
	}

	exec(query, bindings = []) {
		if (typeof query !== "string" || query.length === 0) {
			throw new TypeError("SQL query must be a non-empty string");
		}
		if (UTF8_ENCODER.encode(query).byteLength > MAX_SQL_QUERY_BYTES) {
			throw new RangeError(`SQL query exceeds ${MAX_SQL_QUERY_BYTES} bytes`);
		}
		const cursor = this.#actorSql.exec(query, ...normalizeSqlBindings(bindings));
		const rows = [];
		let resultBytes = 0;
		for (const row of cursor) {
			if (rows.length >= MAX_SQL_RESULT_ROWS) {
				throw new RangeError(`SQL result exceeds ${MAX_SQL_RESULT_ROWS} rows`);
			}
			for (const [name, value] of Object.entries(row)) {
				resultBytes += name.length + sqlValueBytes(value);
			}
			if (resultBytes > MAX_SQL_RESULT_BYTES) {
				throw new RangeError(`SQL result exceeds ${MAX_SQL_RESULT_BYTES} bytes`);
			}
			rows.push(row);
		}
		return {
			rows,
			columnNames: cursor.columnNames,
			rowsRead: cursor.rowsRead,
			rowsWritten: cursor.rowsWritten,
		};
	}

	databaseSize() {
		return this.#actorSql.databaseSize;
	}
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (!authenticated(request, env)) return new Response("not found", { status: 404 });
		if (request.method === "GET" && url.pathname === HEALTH_PATH) {
			return new Response(null, { status: 204 });
		}

		let identity;
		try {
			identity = requestIdentity(request);
		} catch {
			return new Response("invalid actor identity", { status: 400 });
		}
		const name = isolateName(identity);
		if (request.method === "POST" && url.pathname === EVICT_PATH) {
			const activation = activations.get(name);
			// Fence pending preparation without waiting for it. An epoch change
			// prevents a late ready() from dispatching after cleanup completes.
			if (activation !== undefined) {
				activation.active = false;
				activation.epoch++;
			}
			try {
				if (activation?.dispatched) {
					// Recreate the SAME logical capability in this request. A saved
					// JS stub/Worker would retain the earlier request's OutgoingFactory.
					let stub;
					if (activation.fixture === true) {
						stub = env.ACTOR.get(env.ACTOR.idFromName(name));
					} else {
						const worker = loadWorker(env, identity, activation.className, activation);
						await worker.ready();
						stub = env.ACTOR.get(env.ACTOR.idFromName(name), {
							rivetClass: worker.getDurableObjectClass(activation.className),
						});
					}
					try {
						await unsafe.evict(stub, { webSockets: "close" });
					} catch (error) {
						if (!String(error?.message).includes("not currently running")) throw error;
					}
				}
			} finally {
				env.WORKER_LOADER.unload(name);
			}
			if (activations.get(name) === activation && activation !== undefined) {
				// Release source memory, but keep the immutable generation binding.
				activation.code = null;
				activation.dispatched = false;
				activation.active = true;
			}
			return new Response(null, { status: 204 });
		}
		if (request.method === "POST" && url.pathname === PREPARE_PATH) {
			let reference;
			let className;
			try {
				reference = workerReference(request);
				className = durableObjectClass(request);
			} catch {
				return Response.json({ code: "invalid_worker_reference" }, { status: 400 });
			}
			if (reference === null) {
				return Response.json({ code: "missing_worker_reference" }, { status: 400 });
			}
			if (fixtureIdentities.has(name)) {
				return Response.json({ code: "actor_binding_mismatch" }, { status: 409 });
			}
			const activation = await activateWorker(env, identity, reference, className);
			if (activation === null) {
				return Response.json({ code: "actor_binding_mismatch" }, { status: 409 });
			}
			await activation.worker.validateEntrypoint();
			return new Response(null, { status: 204 });
		}
		if (url.pathname.startsWith(MANAGEMENT_PREFIX)) {
			return new Response("not found", { status: 404 });
		}

		if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
			ctx.waitUntil(request.clone().arrayBuffer().then(() => undefined));
		}
		const headers = new Headers(request.headers);
		headers.delete(TOKEN_HEADER);
		let reference;
		let className;
		try {
			reference = workerReference(request);
			className = durableObjectClass(request);
		} catch {
			return Response.json({ code: "invalid_worker_reference" }, { status: 400 });
		}
		headers.delete(WORKER_NAME_HEADER);
		headers.delete(WORKER_VERSION_HEADER);
		headers.delete(DURABLE_OBJECT_CLASS_HEADER);
		let forwarded;
		try {
			forwarded = userRequest(request, headers);
		} catch {
			return Response.json({ code: "invalid_original_url" }, { status: 400 });
		}
		if (reference !== null) {
			if (fixtureIdentities.has(name)) {
				return Response.json({ code: "actor_binding_mismatch" }, { status: 409 });
			}
			const activation = await activateWorker(env, identity, reference, className);
			if (activation === null) {
				return Response.json({ code: "actor_binding_mismatch" }, { status: 409 });
			}
			if (className !== null) {
				const stub = env.ACTOR.get(env.ACTOR.idFromName(name), {
					rivetClass: activation.worker.getDurableObjectClass(className),
				});
				activation.record.dispatched = true;
				return stub.fetch(forwarded);
			}
			return activation.worker.getEntrypoint().fetch(forwarded);
		}
		// Preserve the authenticated, header-free legacy qualification contract.
		// Match the forwarded path so an original business URL cannot hide at '/'.
		const fixturePath = new URL(forwarded.url).pathname;
		if (
			className !== null ||
			!["/", "/increment", "/bottomless-fill", "/bottomless-verify"].includes(fixturePath)
		) {
			return Response.json({ code: "missing_worker_reference" }, { status: 400 });
		}
		const current = activations.get(name);
		if (current !== undefined && (current.active === false || current.workerName !== undefined)) {
			return Response.json({ code: "actor_binding_mismatch" }, { status: 409 });
		}
		if (!fixtureIdentities.has(name) && fixtureIdentities.size >= MAX_FIXTURE_IDENTITIES) {
			return Response.json({ code: "fixture_capacity_exceeded" }, { status: 503 });
		}
		fixtureIdentities.add(name);
		const activation = current ?? { fixture: true, active: true, epoch: 0, dispatched: false };
		activations.set(name, activation);
		const stub = env.ACTOR.get(env.ACTOR.idFromName(name));
		activation.dispatched = true;
		return stub.fetch(forwarded);
	},
};

export class RivetActor extends DurableObject {
	#actorId;
	#generation;
	#actorSql;
	#sqlCapability;

	constructor(state, env) {
		super(state, env);
		const match = /^rivet-v1:([1-9][0-9]*):([A-Za-z0-9_-]{1,128})$/.exec(state.id.name);
		if (!match) throw new TypeError("invalid Rivet workerd isolate identity");
		this.#actorId = match[2];
		this.#generation = Number(match[1]);
		this.#actorSql = state.storage.sql;
		this.#sqlCapability = new RivetSqlCapability(this.#actorSql);
		this.#actorSql.exec(
			"CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)",
		);
		this.#actorSql.exec(
			"CREATE TABLE IF NOT EXISTS bottomless_qualification_payloads " +
				"(chunk INTEGER PRIMARY KEY, payload BLOB NOT NULL)",
		);
	}

	get sql() {
		return this.#sqlCapability;
	}

	async fetch(request) {
		if (
			request.headers.get(ACTOR_ID_HEADER) !== this.#actorId ||
			Number(request.headers.get(GENERATION_HEADER)) !== this.#generation
		) {
			return Response.json({ code: "isolate_identity_mismatch" }, { status: 409 });
		}
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/increment") {
			this.#actorSql.exec(
				"INSERT INTO counters (name, value) VALUES ('main', 1) " +
					"ON CONFLICT (name) DO UPDATE SET value = value + 1",
			);
		}
		if (request.method === "POST" && url.pathname === "/bottomless-fill") {
			const chunk = Number(url.searchParams.get("chunk"));
			const bytes = Number(url.searchParams.get("bytes"));
			const chunks = Number(url.searchParams.get("chunks") ?? "1");
			if (
				!Number.isInteger(chunk) ||
				chunk < 0 ||
				!Number.isInteger(chunks) ||
				chunks <= 0 ||
				chunks > MAX_QUALIFICATION_CHUNKS_PER_WRITE ||
				chunk + chunks > MAX_QUALIFICATION_CHUNKS ||
				!Number.isInteger(bytes) ||
				bytes <= 0 ||
				bytes > MAX_QUALIFICATION_CHUNK_BYTES
			) {
				return Response.json({ code: "invalid_bottomless_fill" }, { status: 400 });
			}
			// A stable chunk key makes a retry safe if the HTTP response is lost after SQLite commit.
			// zeroblob grows the real database without allocating the payload in the isolate heap.
			this.#actorSql.exec(
				"WITH RECURSIVE seq(chunk) AS (" +
					"SELECT ? UNION ALL SELECT chunk + 1 FROM seq WHERE chunk + 1 < ?" +
					") INSERT INTO bottomless_qualification_payloads (chunk, payload) " +
					"SELECT chunk, zeroblob(?) FROM seq WHERE true " +
					"ON CONFLICT (chunk) DO UPDATE SET payload = excluded.payload",
				chunk,
				chunk + chunks,
				bytes,
			);
		}
		const row = this.#actorSql
			.exec(
				"SELECT COALESCE((SELECT value FROM counters WHERE name = 'main'), 0) AS count",
			)
			.one();
		const payload = this.#actorSql
			.exec(
				"SELECT COUNT(*) AS chunks, COALESCE(SUM(length(payload)), 0) AS bytes " +
					"FROM bottomless_qualification_payloads",
			)
			.one();
		const response = {
			actorId: this.#actorId,
			generation: this.#generation,
			count: row.count,
			bottomlessChunks: payload.chunks,
			bottomlessBytes: payload.bytes,
		};
		if (request.method === "GET" && url.pathname === "/bottomless-verify") {
			const integrity = this.#actorSql
				.exec(
					"SELECT COALESCE(SUM(payload != zeroblob(length(payload))), 0) AS corrupt_chunks " +
						"FROM bottomless_qualification_payloads",
				)
				.one();
			response.bottomlessCorruptChunks = integrity.corrupt_chunks;
		}
		return Response.json(response);
	}
}
