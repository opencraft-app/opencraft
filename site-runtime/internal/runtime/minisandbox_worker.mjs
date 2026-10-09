import { DurableObject } from "cloudflare:workers";
// User modules are linked lazily, after the platform captures and protects the
// primitives used by permission/bounds checks. Static user imports could patch
// Headers/SQL checks before the platform module initialized.
const Object = globalThis.Object, Array = globalThis.Array;
const String = globalThis.String, Number = globalThis.Number;
const RegExp = globalThis.RegExp, ArrayBuffer = globalThis.ArrayBuffer;
const Headers = globalThis.Headers, Request = globalThis.Request;
const Response = globalThis.Response, URL = globalThis.URL;
const TextEncoder = globalThis.TextEncoder;
const TypeError = globalThis.TypeError, RangeError = globalThis.RangeError;
const Promise = globalThis.Promise;
const setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout;
// Capture brand-checked accessors before any backend is imported. workerd
// inherits body from Body.prototype rather than defining it on Response.prototype.
// Walk only the pristine native prototype chain; never inspect a user instance.
function responseGetter(name) {
  for (let prototype = Response.prototype; prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor && typeof descriptor.get === "function") return descriptor.get;
  }
  throw new TypeError("native Response accessor unavailable: " + name);
}
const responseHeaders = responseGetter("headers");
const responseStatus = responseGetter("status");
const responseStatusText = responseGetter("statusText");
const responseBody = responseGetter("body");
const headersForEach = Headers.prototype.forEach;
const apply = globalThis.Reflect.apply;
const MAX_HANDLER_MS = 3500; // Finish before the outer five-second invocation deadline.
for (const intrinsic of [Object, Array, String, Number, RegExp, ArrayBuffer, Headers, Request, Response, URL, TextEncoder, TypeError, RangeError, globalThis.Function, globalThis.Promise, DurableObject]) {
  if (intrinsic.prototype) Object.freeze(intrinsic.prototype);
  Object.freeze(intrinsic);
}
const encoder = new TextEncoder();
const MAX_QUERY_BYTES = 65536;
const MAX_BINDINGS_BYTES = 1048576;
const MAX_RESULT_BYTES = 1048576;

function executionResponse(response, digest) {
  const headers = new Headers();
  // Getter/method functions themselves can have a user-defined own `call`;
  // invoke captured builtins directly through captured Reflect.apply instead.
  apply(headersForEach, apply(responseHeaders, response, []), [(value, name) => headers.set(name, value)]);
  headers.set("X-Lightvela-Execution-Package-ID", platformPackageID);
  headers.set("X-Lightvela-Execution-Backend-SHA256", digest);
  // A new response detaches the stamped headers from any object retained by
  // user code, including immutable responses. Native getters ignore subclasses
  // and own-property forgeries, and reject non-Response objects by brand.
  return new Response(apply(responseBody, response, []), {
    status: apply(responseStatus, response, []), statusText: apply(responseStatusText, response, []), headers
  });
}

function valueBytes(value) {
  if (value === null || typeof value === "number") return 8;
  if (typeof value === "string") return encoder.encode(value).byteLength;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  throw new TypeError("unsupported SQL value");
}
// Share sessions must not acquire writable SQL capabilities, even when the
// application implements a GET with side effects. Permit one SELECT only;
// reject additional statements while accepting quoted strings and comments.
function readQuery(query) {
  const text = query.trim();
  if (!/^SELECT\b/i.test(text)) throw new TypeError("share storage is read-only: SELECT required");
  let quote = "", line = false, block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (line) { if (c === "\n") line = false; continue; }
    if (block) { if (c === "*" && next === "/") { block = false; i++; } continue; }
    if (quote) {
      if (c === quote) { if (next === quote) { i++; } else { quote = ""; } }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "[") { quote = "]"; continue; }
    if (c === "-" && next === "-") { line = true; i++; continue; }
    if (c === "/" && next === "*") { block = true; i++; continue; }
    if (c === ";" && text.slice(i + 1).trim() !== "") throw new TypeError("share SQL must be one SELECT");
  }
  if (quote || block) throw new TypeError("unterminated SQL token");
}
function sqlCapability(storage, readOnly, isActive) {
  return Object.freeze({
    async exec(query, bindings = []) {
      if (!isActive()) throw new TypeError("SQL invocation has ended");
      if (typeof query !== "string" || !query.trim() || encoder.encode(query).byteLength > MAX_QUERY_BYTES) throw new TypeError("invalid SQL query");
      if (!Array.isArray(bindings) || bindings.length > 256) throw new TypeError("invalid SQL bindings");
      let bindingBytes = 0;
      for (const value of bindings) {
        if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("invalid SQL number");
        bindingBytes += valueBytes(value);
      }
      if (bindingBytes > MAX_BINDINGS_BYTES) throw new RangeError("SQL bindings too large");
      if (readOnly) readQuery(query);
      // Query and result bounds roll back the entire SQL call rather than
      // committing a partial write and merely returning an error afterwards.
      return storage.transactionSync(() => {
        const cursor = storage.sql.exec(query, ...bindings);
        const rows = []; let bytes = 0;
        for (const row of cursor) {
          if (rows.length >= 1000) throw new RangeError("SQL result has too many rows");
          for (const [key, value] of Object.entries(row)) bytes += encoder.encode(key).byteLength + valueBytes(value);
          if (bytes > MAX_RESULT_BYTES) throw new RangeError("SQL result too large");
          rows.push(row);
        }
        if (readOnly && cursor.rowsWritten > 0) throw new TypeError("share storage is read-only");
        return { rows, columnNames: cursor.columnNames, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
      });
    },
    async databaseSize() {
      if (!isActive()) throw new TypeError("SQL invocation has ended");
      return storage.sql.databaseSize;
    }
  });
}
export class VelaSite extends DurableObject {
  #storage;
  #abort;
  #tail = Promise.resolve();
  #active = false;
  constructor(state, env) {
    super(state, env);
    this.#storage = state.storage;
    this.#abort = state.abort.bind(state);
  }
  async fetch(request) {
    // Private control-plane readiness checks the actual durable isolate, not
    // only the newly compiled stateless entrypoint. No user fetch/SQL runs.
    if (new URL(request.url).pathname === "/__platform_prepare") {
      const expected = request.headers.get("X-Lightvela-Expected-Package-ID");
      if (expected !== null && !/^[a-f0-9]{64}$/.test(expected)) {
        return Response.json({code: "invalid_package_target"}, {status: 400});
      }
      // Workerd's ordinary eviction retains the first dynamic class container.
      // Native abort breaks that stale container, keeping the stable Actor/Depot
      // database identity. The publisher holds the site's operation lock and
      // invokes only this private control path, never an application handler.
      if (expected !== null && expected !== platformPackageID) {
        if (this.#active) return Response.json({code: "package_rotation_busy"}, {status: 503});
        this.#abort("platform immutable package rotation");
      }
      return Response.json({package_id: platformPackageID});
    }
    const digest = request.headers.get("X-Lightvela-Backend-Digest");
    const loader = Object.hasOwn(backends, digest) ? backends[digest] : undefined;
    if (!loader) return new Response("release unavailable", {status: 409});
    const readOnly = request.headers.get("X-Lightvela-Storage-Read-Only") === "1";
    const headers = new Headers();
    for (const name of ["Content-Type", "Accept"]) { const value = request.headers.get(name); if (value !== null) headers.set(name, value); }
    const url = new URL(request.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return new Response("not found", {status: 404});
    const safeRequest = new Request(request, {headers});
    // User modules retain state across requests. Revoke escaped SQL objects at
    // completion and serialize handlers so a share cannot borrow a still-live
    // owner capability while its original handler is suspended on an await.
    const previous = this.#tail;
    let release;
    this.#tail = new Promise(resolve => { release = resolve; });
    await previous;
    let active = true, timer;
    this.#active = true;
    try {
      const sql = sqlCapability(this.#storage, readOnly, () => active);
      const env = Object.freeze({ RIVET_STORAGE: Object.freeze({sql}) });
      const ctx = Object.freeze({ waitUntil() { throw new TypeError("background work is not supported"); } });
      // Outer HTTP cancellation alone cannot release a suspended JS handler.
      // On timeout revoke its SQL object before letting the next request run;
      // a late continuation cannot use the escaped capability again.
      const response = await Promise.race([
        (async () => {
          const backend = (await loader()).default;
          if (!active) throw new TypeError("application invocation has ended");
          if (!backend || typeof backend.fetch !== "function") throw new TypeError("fetch export required");
          return await backend.fetch(safeRequest, env, ctx);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new TypeError("application deadline exceeded")), MAX_HANDLER_MS); })
      ]);
      return executionResponse(response, digest);
    } catch { return executionResponse(new Response("application execution failed", {status: 500}), digest); }
    finally {
      active = false;
      this.#active = false;
      clearTimeout(timer);
      release();
    }
  }
}
// Workers API requires a default fetch export during preparation. Website
// invocations use only the stable VelaSite DO, never stateless /dispatch.
Object.freeze(VelaSite.prototype);
Object.freeze(VelaSite);
const facade = Object.freeze({
  async fetch(request) {
    if (new URL(request.url).pathname !== "/__platform_prepare") return new Response("Durable Object invocation required", {status:404});
    for (const loader of Object.values(backends)) {
      const backend = (await loader()).default;
      if (!backend || typeof backend.fetch !== "function") throw new TypeError("fetch export required");
    }
    return Response.json({package_id:platformPackageID});
  }
});
export default facade;
