// Runs the shared storage-port conformance suites inside a SQLite-backed
// Durable Object in workerd. Bundled and driven by
// tests/storage/storage-ports-workerd.test.ts; every case gets a fresh object
// (or a fresh R2 prefix), so state never leaks between cases.
import { DurableObject } from "cloudflare:workers";
import { SQL_CONFORMANCE_CASES } from "@opencraft/sql/conformance";
import { STATE_DOCUMENT_CONFORMANCE_CASES } from "@opencraft/document-storage/state-conformance";
import { SECRET_CONFORMANCE_CASES } from "@opencraft/secret-storage/conformance";
import { BLOB_CONFORMANCE_CASES } from "@opencraft/blob-storage/conformance";
import { BlobExistsError, BlobDigestError } from "@opencraft/blob-storage";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import { durableObjectStateDocumentStore } from "@opencraft/storage-cloudflare/state";
import { durableObjectKeyMaterial, durableObjectSecretStore } from "@opencraft/storage-cloudflare/secrets";
import { r2BlobStore } from "@opencraft/storage-cloudflare/blob";
import type { DurableObjectStorage, R2Bucket } from "@opencraft/storage-cloudflare/bindings";

interface Env {
  readonly STORAGE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  readonly BUCKET: R2Bucket;
}

type Probe = (storage: DurableObjectStorage, env: Env, prefix: string) => Promise<unknown> | unknown;

const MiB = 1024 * 1024;
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const pattern = (size: number) => { const bytes = new Uint8Array(size); for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff; return bytes; };
const chunked = (bytes: Uint8Array, chunk: number) => new ReadableStream<Uint8Array>({
  start(controller) { for (let offset = 0; offset < bytes.byteLength; offset += chunk) controller.enqueue(bytes.slice(offset, offset + chunk)); controller.close(); },
});
async function collect(body: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return all;
}
const failure = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const attempt = (action: () => unknown) => { try { return { value: action() }; } catch (error) { return { error: failure(error) }; } };

/** Evidence for the SQL semantics questions in cloudflare-deployment.md §4, plus adapter-specific checks. */
const PROBES: Record<string, Probe> = {
  "sql: changes() vs rowsWritten"(storage) {
    const db = durableObjectSqlDatabase(storage);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL) STRICT; CREATE INDEX t_v ON t(v);");
    db.prepare("INSERT INTO t VALUES(1,0),(2,0)").run();
    const cursor = storage.sql.exec("UPDATE t SET v=v+1") as unknown as { toArray(): unknown; rowsWritten: number };
    cursor.toArray();
    const changes = Number(storage.sql.exec("SELECT changes() AS c").one().c);
    return { changes, rowsWritten: cursor.rowsWritten };
  },
  "sql: transaction-control text is refused by workerd"(storage) {
    return ["BEGIN", "SAVEPOINT s", "COMMIT"].map((text) => attempt(() => durableObjectSqlDatabase(storage).exec(text)));
  },
  "sql: sqlite_master and PRAGMA reads"(storage) {
    const db = durableObjectSqlDatabase(storage);
    db.exec("CREATE TABLE a(x INTEGER) STRICT; CREATE INDEX a_x ON a(x);");
    return {
      objects: db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").all(),
      foreignKeys: attempt(() => db.prepare("PRAGMA foreign_keys").get()),
    };
  },
  "sql: one storage object maps to one port object"(storage) {
    return durableObjectSqlDatabase(storage) === durableObjectSqlDatabase(storage);
  },
  "sql: integers outside the safe range"(storage) {
    const db = durableObjectSqlDatabase(storage);
    return {
      bindSafeBigint: attempt(() => db.prepare("SELECT ? AS v").get(9007199254740991n)),
      bindUnsafeBigint: attempt(() => db.prepare("SELECT ? AS v").get(9007199254740993n)),
      readUnsafeLiteral: attempt(() => String(db.prepare("SELECT 9007199254740993 AS v").get()!.v)),
    };
  },
  async "blob: multipart bodies verify size and digest before they become visible"(_storage, env, prefix) {
    const store = r2BlobStore(env.BUCKET, { prefix, partBytes: 5 * MiB });
    const bytes = pattern(11 * MiB + 3);
    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    const info = await store.put("big", chunked(bytes, 1 * MiB + 17), { maxBytes: bytes.byteLength, sha256 });
    const whole = await collect((await store.get("big"))!.body);
    const tail = await collect((await store.get("big", { offset: 11 * MiB, length: 10 }))!.body);
    const results: Record<string, unknown> = {
      info: { ...info, matches: info.sha256 === sha256 },
      roundTrip: whole.byteLength === bytes.byteLength && whole.every((value, i) => value === bytes[i]),
      tail: [...tail],
      expectedTail: [...bytes.slice(11 * MiB, 11 * MiB + 3)],
    };
    try { await store.put("big", chunked(bytes, MiB), { maxBytes: bytes.byteLength }); results.overwrite = "accepted"; } catch (error) { results.overwrite = error instanceof BlobExistsError ? "BlobExistsError" : failure(error); }
    const upload = await store.upload("bad", { maxBytes: bytes.byteLength });
    for (let offset = 0; offset < bytes.byteLength; offset += 3 * MiB) await upload.write(bytes.slice(offset, offset + 3 * MiB));
    try { await upload.complete({ sha256: "0".repeat(64) }); results.badDigest = "accepted"; } catch (error) { results.badDigest = error instanceof BlobDigestError ? "BlobDigestError" : failure(error); }
    results.badDigestVisible = await store.head("bad");
    const raced = await Promise.allSettled([1, 2].map(async () => {
      const racer = await store.upload("raced", { maxBytes: bytes.byteLength });
      await racer.write(bytes);
      return racer.complete();
    }));
    results.racedOutcomes = raced.map((outcome) => outcome.status === "fulfilled" ? "stored" : outcome.reason instanceof BlobExistsError ? "BlobExistsError" : failure(outcome.reason));
    return results;
  },
  async "blob: concurrent single-part puts to one key store exactly one"(_storage, env, prefix) {
    const store = r2BlobStore(env.BUCKET, { prefix });
    const outcomes = await Promise.allSettled(["one", "two", "three"].map((text) => store.put("k", new TextEncoder().encode(text), { maxBytes: 8 })));
    return outcomes.map((outcome) => outcome.status === "fulfilled" ? "stored" : outcome.reason instanceof BlobExistsError ? "BlobExistsError" : failure(outcome.reason));
  },
};

const SUITES = {
  sql: SQL_CONFORMANCE_CASES.length,
  state: STATE_DOCUMENT_CONFORMANCE_CASES.length,
  secret: SECRET_CONFORMANCE_CASES.length,
  blob: BLOB_CONFORMANCE_CASES.length,
};

export class ConformanceObject extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const { suite, index, name, prefix } = await request.json() as { suite: string; index?: number; name?: string; prefix: string };
    const storage = this.ctx.storage as unknown as DurableObjectStorage;
    try {
      let result: unknown = null;
      if (suite === "sql") SQL_CONFORMANCE_CASES[index!]!.run(durableObjectSqlDatabase(storage));
      else if (suite === "state") {
        // The adapter stores each document's JSON text under `state/<key>`; corrupt it in place.
        await STATE_DOCUMENT_CONFORMANCE_CASES[index!]!.run(durableObjectStateDocumentStore(storage), async (key) => storage.kv.put(`state/${key}`, "{not json"));
      }
      else if (suite === "secret") await SECRET_CONFORMANCE_CASES[index!]!.run({ secrets: durableObjectSecretStore(storage), keys: durableObjectKeyMaterial(storage) });
      else if (suite === "blob") await BLOB_CONFORMANCE_CASES[index!]!.run(r2BlobStore(this.env.BUCKET, { prefix }));
      else if (suite === "probe") result = await PROBES[name!]!(storage, this.env, prefix);
      else throw new Error(`Unknown suite ${suite}`);
      return Response.json({ ok: true, result });
    } catch (error) {
      return Response.json({ ok: false, error: failure(error), stack: error instanceof Error ? error.stack : undefined });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET") return Response.json({ suites: SUITES, probes: Object.keys(PROBES) });
    const body = await request.clone().json() as { prefix: string };
    // A fresh object per case: its SQL database and KV storage start empty.
    return env.STORAGE.get(env.STORAGE.idFromName(body.prefix)).fetch(request);
  },
};
