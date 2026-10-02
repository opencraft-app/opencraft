const WORKER_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const CLASS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const ID_PATTERN = /^[0-9a-f]{64}$/;
const ORIGINAL_URL_HEADER = "x-workers-original-url";

export interface AgentClientOptions {
	/** Complete Workers API URL, including the /v1 path. */
	endpoint: string;
	/** Fetch implementation for non-browser runtimes or tests. */
	fetch?: typeof globalThis.fetch;
}

/** A JSON-safe, environment-independent reference to one Agent incarnation. */
export interface AgentRef {
	readonly object: "agent";
	readonly version: 1;
	readonly worker: string;
	readonly class_name: string;
	readonly id: string;
}

export interface AgentRequestOptions {
	signal?: AbortSignal;
}

interface ObjectRefResponse {
	object?: string;
	id?: string;
	worker?: string;
	class_name?: string;
}

interface ErrorEnvelope {
	error?: {
		code?: string;
		message?: string;
		retryable?: boolean;
		request_id?: string;
	};
}

export class AgentError extends Error {
	readonly code: string;
	readonly status?: number;
	readonly retryable: boolean;
	readonly requestId?: string;

	constructor(
		code: string,
		message: string,
		options: {
			status?: number;
			retryable?: boolean;
			requestId?: string;
			cause?: unknown;
		} = {},
	) {
		super(message, { cause: options.cause });
		this.name = "AgentError";
		this.code = code;
		this.status = options.status;
		this.retryable = options.retryable ?? false;
		this.requestId = options.requestId;
	}
}

export function isAgentError(error: unknown, code?: string): error is AgentError {
	return error instanceof AgentError && (code === undefined || error.code === code);
}

export class AgentClient {
	readonly #endpoint: string;
	readonly #fetch: typeof globalThis.fetch;

	constructor(options: AgentClientOptions) {
		if (options === null || typeof options !== "object") {
			throw new TypeError("AgentClient options are required");
		}
		this.#endpoint = normalizeEndpoint(options.endpoint);
		this.#fetch = options.fetch ?? globalThis.fetch;
		if (typeof this.#fetch !== "function") {
			throw new TypeError("A Fetch API implementation is required");
		}
	}

	kind(worker: string, className: string): AgentKind {
		return new AgentKind(this, worker, className);
	}

	/** Rebinds a persisted AgentRef without creating or contacting the Agent. */
	get(ref: AgentRef): Agent {
		return new Agent(this, normalizeRef(ref));
	}

	async create(ref: AgentRef, options: AgentRequestOptions = {}): Promise<Agent> {
		const normalized = normalizeRef(ref);
		const response = await this.#request(
			this.#objectURL(normalized),
			{ method: "PUT", signal: options.signal },
			true,
		);
		const objectRef = (await readJson(response, "PUT")) as ObjectRefResponse;
		if (
			objectRef.object !== "object" ||
			objectRef.id !== normalized.id ||
			objectRef.worker !== normalized.worker ||
			objectRef.class_name !== normalized.class_name
		) {
			throw new AgentError(
				"invalid_api_response",
				"Workers API returned an invalid Agent reference",
				{ status: response.status, retryable: true },
			);
		}
		return new Agent(this, normalized);
	}

	async fetch(ref: AgentRef, input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const normalized = normalizeRef(ref);
		const request = new Request(input, init);
		const headers = new Headers(request.headers);
		headers.set(ORIGINAL_URL_HEADER, request.url);
		const response = await this.#request(
			`${this.#objectURL(normalized)}/fetch`,
			{
				method: request.method,
				headers,
				body:
					request.method === "GET" || request.method === "HEAD"
						? undefined
						: request.body,
				...(request.body === null ? {} : { duplex: "half" }),
				signal: request.signal,
			} as RequestInit,
			false,
		);
		if (response.headers.get("x-workers-error") === "true") {
			await throwAPIError(response, request.method);
		}
		return response;
	}

	async delete(ref: AgentRef, options: AgentRequestOptions = {}): Promise<void> {
		const normalized = normalizeRef(ref);
		await this.#request(
			this.#objectURL(normalized),
			{ method: "DELETE", signal: options.signal },
			true,
		);
	}

	#objectURL(ref: AgentRef): string {
		return `${this.#endpoint}/workers/${encodeURIComponent(ref.worker)}/objects/${encodeURIComponent(ref.class_name)}/${encodeURIComponent(ref.id)}`;
	}

	async #request(url: string, init: RequestInit, requireOK: boolean): Promise<Response> {
		const headers = new Headers(init.headers);
		let response: Response;
		try {
			response = await this.#fetch(url, { ...init, headers });
		} catch (error) {
			if (error instanceof AgentError) throw error;
			const aborted = init.signal?.aborted === true;
			throw new AgentError(
				aborted ? "request_cancelled" : "api_unavailable",
				aborted ? "Agent request was cancelled" : `Workers API is unavailable: ${String(error)}`,
				{ retryable: !aborted, cause: error },
			);
		}
		if (requireOK && (!response.ok || response.headers.get("x-workers-error") === "true")) {
			await throwAPIError(response, init.method ?? "GET");
		}
		return response;
	}
}

export class AgentKind {
	readonly #client: AgentClient;
	readonly worker: string;
	readonly className: string;

	constructor(client: AgentClient, worker: string, className: string) {
		if (!WORKER_PATTERN.test(worker)) throw new TypeError("Worker name is invalid");
		if (!CLASS_PATTERN.test(className)) throw new TypeError("Agent class name is invalid");
		this.#client = client;
		this.worker = worker;
		this.className = className;
	}

	/** Allocates a random Agent identity locally without network I/O. */
	newAgent(): Agent {
		return new Agent(this.#client, {
			object: "agent",
			version: 1,
			worker: this.worker,
			class_name: this.className,
			id: randomAgentId(),
		});
	}

	/** Allocates and creates a new Agent. Use newAgent() first when retaining the ID across retries matters. */
	async create(options: AgentRequestOptions = {}): Promise<Agent> {
		const agent = this.newAgent();
		return agent.create(options);
	}

	/** Binds an existing opaque ID without network I/O. */
	get(id: string): Agent {
		return new Agent(this.#client, {
			object: "agent",
			version: 1,
			worker: this.worker,
			class_name: this.className,
			id,
		});
	}
}

export class Agent {
	readonly #client: AgentClient;
	readonly ref: AgentRef;

	constructor(client: AgentClient, ref: AgentRef) {
		this.#client = client;
		this.ref = Object.freeze(normalizeRef(ref));
	}

	get id(): string {
		return this.ref.id;
	}

	create(options: AgentRequestOptions = {}): Promise<Agent> {
		return this.#client.create(this.ref, options);
	}

	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		return this.#client.fetch(this.ref, input, init);
	}

	delete(options: AgentRequestOptions = {}): Promise<void> {
		return this.#client.delete(this.ref, options);
	}

	toJSON(): AgentRef {
		return this.ref;
	}
}

function normalizeEndpoint(value: string): string {
	if (typeof value !== "string") throw new TypeError("endpoint is required");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("endpoint must be an absolute HTTP URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError("endpoint must be an absolute HTTP URL");
	}
	if (url.pathname.replace(/\/$/, "") !== "/v1" || url.search !== "" || url.hash !== "") {
		throw new TypeError("endpoint must be the complete Workers API /v1 URL");
	}
	url.pathname = "/v1";
	return url.toString().replace(/\/$/, "");
}

function normalizeRef(value: AgentRef): AgentRef {
	if (value === null || typeof value !== "object") throw new TypeError("AgentRef is required");
	if (value.object !== "agent" || value.version !== 1) {
		throw new TypeError("AgentRef has an unsupported format");
	}
	if (!WORKER_PATTERN.test(value.worker)) throw new TypeError("AgentRef worker is invalid");
	if (!CLASS_PATTERN.test(value.class_name)) throw new TypeError("AgentRef class name is invalid");
	if (!ID_PATTERN.test(value.id)) {
		throw new TypeError("AgentRef ID must be a 64-character lowercase hex string");
	}
	return {
		object: "agent",
		version: 1,
		worker: value.worker,
		class_name: value.class_name,
		id: value.id,
	};
}

function randomAgentId(): string {
	const bytes = new Uint8Array(32);
	if (typeof globalThis.crypto?.getRandomValues !== "function") {
		throw new TypeError("Web Crypto getRandomValues() is required to allocate an Agent ID");
	}
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(response: Response, method: string): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new AgentError(
			"invalid_api_response",
			`${method} returned invalid JSON`,
			{ status: response.status, retryable: true, cause: error },
		);
	}
}

async function throwAPIError(response: Response, method: string): Promise<never> {
	const text = await response.text();
	let envelope: ErrorEnvelope | undefined;
	try {
		envelope = JSON.parse(text) as ErrorEnvelope;
	} catch {
		// Fall through to the stable invalid-response error.
	}
	if (envelope?.error?.code && envelope.error.message) {
		throw new AgentError(envelope.error.code, envelope.error.message, {
			status: response.status,
			retryable: envelope.error.retryable ?? false,
			requestId: envelope.error.request_id,
		});
	}
	throw new AgentError(
		"invalid_api_response",
		`${method} returned an invalid Workers API error response`,
		{ status: response.status, retryable: response.status >= 500 },
	);
}
