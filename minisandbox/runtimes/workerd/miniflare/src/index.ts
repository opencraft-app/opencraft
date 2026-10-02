import { createHash, randomBytes } from "node:crypto";

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const BINDING_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const CLASS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const ID_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^v_[0-9a-f]{64}$/;
const DEPLOYMENT_PATTERN = /^d_[0-9a-f]{32}$/;
const DEFAULT_COMPATIBILITY_DATE = "2026-08-14";
const ORIGINAL_URL_HEADER = "x-workers-original-url";
const REQUEST_TIMEOUT_MS = 60_000;

export interface ModuleDefinition {
	type?: "ESModule";
	path: string;
	contents: string;
}

export interface DurableObjectDefinition {
	className: string;
}

export interface MiniflareOptions {
	endpoint: string;
	token?: string;
	name?: string;
	script?: string;
	modules?: ModuleDefinition[];
	mainModule?: string;
	compatibilityDate?: string;
	compatibilityFlags?: string[];
	durableObjects?: Record<string, string | DurableObjectDefinition>;
}

interface NormalizedOptions {
	name: string;
	mainModule: string;
	modules: Record<string, string>;
	compatibilityDate: string;
	compatibilityFlags: string[];
	durableObjects: Map<string, string>;
	endpoint: string;
	token?: string;
}

export interface Version {
	object: "version";
	id: string;
	worker: string;
	digest: string;
	created_at: string;
	main_module: string;
	module_count: number;
	compatibility_date: string;
}

export interface DeploymentVersion {
	version_id: string;
	percentage: number;
}

export interface Deployment {
	object: "deployment";
	id: string;
	worker: string;
	versions: DeploymentVersion[];
	deployed_at: string;
}

export interface Worker {
	object: "worker";
	name: string;
	deployment?: Deployment;
	versions: Version[];
}

export interface ObjectRef {
	object: "object";
	id: string;
	worker: string;
	class_name: string;
}

interface ErrorEnvelope {
	error?: {
		code?: string;
		message?: string;
		retryable?: boolean;
		request_id?: string;
	};
}

export class MiniflareError extends Error {
	readonly code: string;
	readonly status?: number;
	readonly retryable: boolean;
	readonly requestId?: string;

	constructor(
		code: string,
		message: string,
		status?: number,
		retryable = false,
		requestId?: string,
	) {
		super(message);
		this.name = "MiniflareError";
		this.code = code;
		this.status = status;
		this.retryable = retryable;
		this.requestId = requestId;
	}
}

export class DurableObjectId {
	readonly name?: string;
	readonly #value: string;

	constructor(value: string, name?: string) {
		if (!ID_PATTERN.test(value)) {
			throw new TypeError("Durable Object ID must be a 64-character lowercase hex string");
		}
		this.#value = value;
		this.name = name;
	}

	equals(other: DurableObjectId): boolean {
		return this.#value === other.#value;
	}

	toString(): string {
		return this.#value;
	}
}

export class DurableObjectStub {
	readonly id: DurableObjectId;
	readonly name?: string;
	readonly #client: Miniflare;
	readonly #binding: string;
	readonly #className: string;
	readonly #epoch: number;

	constructor(
		client: Miniflare,
		binding: string,
		className: string,
		id: DurableObjectId,
		epoch: number,
	) {
		this.#client = client;
		this.#binding = binding;
		this.#className = className;
		this.id = id;
		this.name = id.name;
		this.#epoch = epoch;
	}

	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		return this.#client.fetchDurableObject(
			this.#binding,
			this.#className,
			this.id,
			this.#epoch,
			input,
			init,
		);
	}

	delete(): Promise<void> {
		return this.#client.deleteDurableObject(this.#className, this.id, this.#epoch);
	}
}

export class DurableObjectNamespace {
	readonly #client: Miniflare;
	readonly #binding: string;
	readonly #className: string;
	readonly #epoch: number;

	constructor(client: Miniflare, binding: string, className: string, epoch: number) {
		this.#client = client;
		this.#binding = binding;
		this.#className = className;
		this.#epoch = epoch;
	}

	idFromName(name: string): DurableObjectId {
		if (typeof name !== "string") throw new TypeError("Durable Object name must be a string");
		return new DurableObjectId(
			digest([this.#client.workerName, this.#className, name]),
			name,
		);
	}

	idFromString(id: string): DurableObjectId {
		return new DurableObjectId(id);
	}

	newUniqueId(): DurableObjectId {
		return new DurableObjectId(randomBytes(32).toString("hex"));
	}

	get(id: DurableObjectId): DurableObjectStub {
		if (!(id instanceof DurableObjectId)) throw new TypeError("Expected a DurableObjectId");
		return new DurableObjectStub(
			this.#client,
			this.#binding,
			this.#className,
			id,
			this.#epoch,
		);
	}

	getByName(name: string): DurableObjectStub {
		return this.get(this.idFromName(name));
	}
}

export class Miniflare {
	#options: NormalizedOptions;
	#epoch = 0;
	#disposed = false;
	#update: Promise<void>;
	#deploymentId?: string;

	constructor(options: MiniflareOptions) {
		this.#options = normalizeOptions(options);
		this.#update = this.deploy(this.#options);
	}

	get ready(): Promise<void> {
		return this.#update;
	}

	get workerName(): string {
		return this.#options.name;
	}

	async getWorker(): Promise<Worker> {
		this.assertUsable();
		await this.#update;
		return requestJson<Worker>(new URL(workerURL(this.#options)), {
			headers: requestHeaders(this.#options.token),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}

	async setOptions(options: MiniflareOptions): Promise<void> {
		this.assertUsable();
		const next = normalizeOptions(options);
		if (next.name !== this.#options.name) {
			throw new MiniflareError(
				"ERR_WORKER_IDENTITY_CHANGED",
				"setOptions() cannot change the Worker name",
			);
		}
		const previous = this.#update.catch(() => undefined);
		this.#epoch++;
		this.#update = previous.then(async () => {
			const previousOptions = this.#options;
			try {
				await this.deploy(next);
				this.#options = next;
			} catch (error) {
				this.#options = previousOptions;
				throw error;
			}
		});
		await this.#update;
	}

	async dispatchFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		this.assertUsable();
		await this.#update;
		const id = new DurableObjectId(digest([this.workerName, "default"]), "default");
		return this.fetchActor(null, null, id, this.#epoch, input, init);
	}

	async getDurableObjectNamespace(bindingName: string): Promise<DurableObjectNamespace> {
		this.assertUsable();
		await this.#update;
		const className = this.#options.durableObjects.get(bindingName);
		if (className === undefined) {
			throw new MiniflareError(
				"ERR_BINDING_NOT_FOUND",
				`No Durable Object binding named ${JSON.stringify(bindingName)}`,
			);
		}
		return new DurableObjectNamespace(this, bindingName, className, this.#epoch);
	}

	dispose(): Promise<void> {
		this.#disposed = true;
		this.#epoch++;
		return Promise.resolve();
	}

	async fetchDurableObject(
		binding: string,
		className: string,
		id: DurableObjectId,
		epoch: number,
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> {
		return this.fetchActor(binding, className, id, epoch, input, init);
	}

	async deleteDurableObject(
		className: string,
		id: DurableObjectId,
		epoch: number,
	): Promise<void> {
		this.assertUsable(epoch);
		await this.#update;
		this.assertUsable(epoch);
		const base = workerURL(this.#options);
		const target = new URL(
			`${base}/objects/${encodeURIComponent(className)}/${encodeURIComponent(id.toString())}`,
		);
		let response: Response;
		try {
			response = await fetch(target, {
				method: "DELETE",
				headers: requestHeaders(this.#options.token),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw networkError(error);
		}
		if (!response.ok || response.headers.get("x-workers-error") === "true") {
			await responseJson(response, "DELETE", target);
		}
	}

	private async deploy(options: NormalizedOptions): Promise<void> {
		const base = workerURL(options);
		const version = await requestJson<Version>(
			new URL(`${base}/versions`),
			{
				method: "POST",
				headers: requestHeaders(options.token, true),
				body: JSON.stringify({
					main_module: options.mainModule,
					modules: options.modules,
					compatibility_date: options.compatibilityDate,
					compatibility_flags: options.compatibilityFlags,
					durable_objects: Object.fromEntries(options.durableObjects),
				}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
		if (version.object !== "version" || !VERSION_PATTERN.test(version.id)) {
			throw new MiniflareError(
				"ERR_INVALID_VERSION_RESPONSE",
				"Workers API returned an invalid immutable Version",
			);
		}
		const deployment = await requestJson<Deployment>(
			new URL(`${base}/deployments`),
			{
				method: "POST",
				headers: requestHeaders(options.token, true),
				body: JSON.stringify({
					version_id: version.id,
					...(this.#deploymentId === undefined
						? {}
						: { expected_deployment_id: this.#deploymentId }),
				}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
		if (deployment.object !== "deployment" || !DEPLOYMENT_PATTERN.test(deployment.id)) {
			throw new MiniflareError(
				"ERR_INVALID_DEPLOYMENT_RESPONSE",
				"Workers API returned an invalid Deployment",
			);
		}
		this.#deploymentId = deployment.id;
	}

	private async fetchActor(
		_binding: string | null,
		className: string | null,
		id: DurableObjectId,
		epoch: number,
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> {
		this.assertUsable(epoch);
		await this.#update;
		this.assertUsable(epoch);
		const request = new Request(input, init);
		const base = workerURL(this.#options);
		const target =
			className === null
				? new URL(`${base}/dispatch`)
				: new URL(
						`${base}/objects/${encodeURIComponent(className)}/${encodeURIComponent(id.toString())}/fetch`,
					);
		const headers = new Headers(request.headers);
		headers.set(ORIGINAL_URL_HEADER, request.url);
		if (this.#options.token) {
			headers.set("authorization", `Bearer ${this.#options.token}`);
		}
		let response: Response;
		try {
			response = await fetch(target, {
				method: request.method,
				headers,
				body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
				duplex: request.body === null ? undefined : "half",
				// Worker and Agent fetches may be long-lived or streaming. Control-plane
				// calls keep a bounded timeout, while execution follows caller cancellation.
				signal: request.signal,
			} as RequestInit);
		} catch (error) {
			throw networkError(error);
		}
		if (response.headers.get("x-workers-error") === "true") {
			await responseJson(response, request.method, target);
		}
		return response;
	}

	private assertUsable(epoch = this.#epoch): void {
		if (this.#disposed) {
			throw new MiniflareError("ERR_DISPOSED", "Cannot use a disposed Miniflare instance");
		}
		if (epoch !== this.#epoch) {
			throw new MiniflareError(
				"ERR_STALE_STUB",
				"Durable Object stubs must be recreated after setOptions()",
			);
		}
	}
}

function normalizeOptions(options: MiniflareOptions): NormalizedOptions {
	if (options === null || typeof options !== "object") throw new TypeError("Options are required");
	validateAPIEndpoint(options.endpoint);
	const name = options.name ?? "worker";
	if (!NAME_PATTERN.test(name)) throw new TypeError("Worker name is invalid");
	if ((options.script === undefined) === (options.modules === undefined)) {
		throw new TypeError("Specify exactly one of script or modules");
	}

	let mainModule: string;
	let modules: Record<string, string>;
	if (options.script !== undefined) {
		mainModule = options.mainModule ?? "main.js";
		modules = { [mainModule]: options.script };
	} else {
		const definitions = options.modules ?? [];
		if (definitions.length === 0) throw new TypeError("modules must not be empty");
		modules = Object.fromEntries(
			definitions.map((module) => {
				if (module.type !== undefined && module.type !== "ESModule") {
					throw new TypeError("The minimal runtime supports ESModule modules only");
				}
				return [module.path, module.contents];
			}),
		);
		mainModule = options.mainModule ?? definitions[0].path;
	}
	if (!(mainModule in modules)) throw new TypeError("mainModule is missing from modules");

	const durableObjects = new Map<string, string>();
	for (const [binding, value] of Object.entries(options.durableObjects ?? {})) {
		if (!BINDING_PATTERN.test(binding)) throw new TypeError(`Invalid binding name: ${binding}`);
		const className = typeof value === "string" ? value : value.className;
		if (!CLASS_PATTERN.test(className)) {
			throw new TypeError(`Invalid Durable Object class: ${className}`);
		}
		durableObjects.set(binding, className);
	}

	return {
		name,
		mainModule,
		modules,
		compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
		compatibilityFlags: options.compatibilityFlags ?? [],
		durableObjects,
		endpoint: options.endpoint,
		token: options.token,
	};
}

async function requestJson<T = unknown>(url: URL, init: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		throw networkError(error);
	}
	return responseJson<T>(response, init.method ?? "GET", url);
}

async function responseJson<T>(response: Response, method: string, url: URL): Promise<T> {
	const text = await response.text();
	if (!response.ok) {
		let envelope: ErrorEnvelope | undefined;
		try {
			envelope = JSON.parse(text) as ErrorEnvelope;
		} catch {
			// Fall through to the stable invalid-response error below.
		}
		if (envelope?.error?.code && envelope.error.message) {
			throw new MiniflareError(
				envelope.error.code,
				envelope.error.message,
				response.status,
				envelope.error.retryable ?? false,
				envelope.error.request_id,
			);
		}
		throw new MiniflareError(
			"invalid_api_response",
			`${method} ${url} returned an invalid error response`,
			response.status,
			response.status >= 500,
		);
	}
	if (text === "") return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new MiniflareError(
			"invalid_api_response",
			`${method} ${url} returned invalid JSON: ${String(error)}`,
			response.status,
			true,
		);
	}
}

function requestHeaders(token: string | undefined, json = false): Headers {
	const headers = new Headers();
	if (json) headers.set("content-type", "application/json");
	if (token) headers.set("authorization", `Bearer ${token}`);
	return headers;
}

function validateHttpUrl(value: string, field: string): void {
	if (typeof value !== "string") throw new TypeError(`${field} is required`);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError(`${field} must be an absolute HTTP URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError(`${field} must be an absolute HTTP URL`);
	}
}

function validateAPIEndpoint(value: string): void {
	validateHttpUrl(value, "endpoint");
	const url = new URL(value);
	if (url.pathname.replace(/\/$/, "") !== "/v1" || url.search !== "" || url.hash !== "") {
		throw new TypeError("endpoint must be the complete Workers API /v1 URL");
	}
}

function workerURL(options: Pick<NormalizedOptions, "endpoint" | "name">): string {
	return new URL(
		`workers/${encodeURIComponent(options.name)}`,
		ensureTrailingSlash(options.endpoint),
	).toString().replace(/\/$/, "");
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function digest(parts: string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		hash.update(part);
		hash.update("\0");
	}
	return hash.digest("hex");
}

function networkError(error: unknown): MiniflareError {
	const timeout = error instanceof DOMException && error.name === "TimeoutError";
	return new MiniflareError(
		timeout ? "api_timeout" : "api_unavailable",
		timeout ? "Workers API request timed out" : `Workers API is unavailable: ${String(error)}`,
		timeout ? 504 : undefined,
		true,
	);
}
