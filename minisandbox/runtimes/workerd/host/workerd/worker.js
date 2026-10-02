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

function loadWorker(env, identity, durableObjectClass = null) {
	return env.WORKER_LOADER.get(isolateName(identity), async () => {
		const response = await env.WORKER_CODE.fetch(
			`http://worker-code/__rivet/worker-code/${identity.actorId}/${identity.generation}`,
			{ headers: { [TOKEN_HEADER]: env.RIVET_WORKERD_TOKEN } },
		);
		if (!response.ok) throw new Error(`Worker code unavailable: ${response.status}`);
		const code = await response.json();
		if (code.env === undefined) code.env = {};
		if (code.env === null || typeof code.env !== "object" || Array.isArray(code.env)) {
			throw new TypeError("Worker code env must be an object");
		}
		// The loaded isolate receives only the exact Durable Object stub derived from
		// its authenticated actor identity. It never receives the ACTOR namespace,
		// the workerd token, or an actor ID selector, so it cannot mint a capability
		// for another actor or generation.
		if (durableObjectClass === null) {
			code.env.RIVET_STORAGE = env.ACTOR.get(env.ACTOR.idFromName(isolateName(identity)));
		}
		return code;
	});
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
		if (request.method === "POST" && url.pathname === EVICT_PATH) {
			env.WORKER_LOADER.unload(isolateName(identity));
			const stub = env.ACTOR.get(env.ACTOR.idFromName(isolateName(identity)));
			try {
				await unsafe.evict(stub, { webSockets: "close" });
			} catch (error) {
				if (!String(error?.message).includes("not currently running")) throw error;
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
			const worker = loadWorker(env, identity, className);
			await worker.ready();
			await worker.validateEntrypoint();
			if (className !== null) await worker.validateDurableObjectClass(className);
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
			const worker = loadWorker(env, identity, className);
			if (className !== null) {
				const actorClass = worker.getDurableObjectClass(className);
				const stub = env.ACTOR.get(env.ACTOR.idFromName(isolateName(identity)), {
					rivetClass: actorClass,
				});
				return stub.fetch(forwarded);
			}
			return worker.getEntrypoint().fetch(forwarded);
		}
		if (className !== null) {
			return Response.json({ code: "missing_worker_reference" }, { status: 400 });
		}

		const stub = env.ACTOR.get(env.ACTOR.idFromName(isolateName(identity)));
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
