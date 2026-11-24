// WorkspaceHost-side stores over the runtime-neutral SQL port (gateway-split.md
// §4.2, storage row): the thread directory (`SqlThreadDirectory`) on the
// thread-catalog chain and the employee Git vault (`EmployeeGitVault`) on its
// own chain. Shared by the Durable Object prototype (workspace-stores-worker.ts,
// bundled for workerd) and the Node side of the scenarios (nodeSqlDatabase).
// Every scenario returns plain JSON with random ids normalized, so both
// runtimes are compared result for result.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";
import { applySqlMigrations, hashSqlMigrations, type SqlMigration } from "@opencraft/sql/migrations";
import { resolveStoreMigrations, type StorageSchemaId } from "@opencraft/sqlite-node";
import {
  SNAPSHOT_START,
  SqlThreadDirectory,
  type ThreadDirectoryPort,
} from "@opencraft/app-host-server/thread-directory/domain";
import {
  EMPLOYEE_GIT_VAULT_MIGRATIONS,
  EmployeeGitVault,
  type GitVaultCipher,
  type GitVaultCredential,
} from "@opencraft/execution-environment/employee-git-vault";

/** The thread-catalog owner's published baseline (apps/local-agent-host/src/thread-catalog.ts); the registry checks its checksum. */
const THREAD_CATALOG_BASELINE: readonly SqlMigration[] = [
  {
    version: 1,
    name: "thread-catalog",
    sql: "CREATE TABLE opencraft_threads (id TEXT PRIMARY KEY, document TEXT NOT NULL)",
  },
];
const PUBLISHED: Record<WorkspaceStore, { id: StorageSchemaId; prefix: readonly SqlMigration[] }> = {
  "thread-catalog": { id: "thread-catalog", prefix: THREAD_CATALOG_BASELINE },
  "employee-git-vault-store": { id: "employee-git-vault-store", prefix: EMPLOYEE_GIT_VAULT_MIGRATIONS },
};
export type WorkspaceStore = "thread-catalog" | "employee-git-vault-store";
export const WORKSPACE_STORES = Object.keys(PUBLISHED) as WorkspaceStore[];
/** Each scenario's store; the thread directory runs once per execution mode. */
export type WorkspaceScenario = "directory-remote" | "directory-local" | "vault";
export const WORKSPACE_SCENARIOS: Record<WorkspaceScenario, WorkspaceStore> = {
  "directory-remote": "thread-catalog",
  "directory-local": "thread-catalog",
  vault: "employee-git-vault-store",
};

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** The full published chain the Node owner applies, with the checksums its ledger records. */
export function publishedMigrations(store: WorkspaceStore) {
  const { id, prefix } = PUBLISHED[store];
  return hashSqlMigrations(resolveStoreMigrations(id, prefix), sha256Hex);
}
export function migrate(database: SqlDatabase, store: WorkspaceStore) {
  applySqlMigrations(database, publishedMigrations(store));
  return ledger(database);
}
export function ledger(database: SqlDatabase) {
  return database
    .prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => ({ version: Number(row.version), name: String(row.name), checksum: String(row.checksum) }));
}
/** User objects only; runtime-owned tables (`_cf_*`, `sqlite_*`) are excluded. */
export function schema(database: SqlDatabase) {
  return database
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name!='schema_migrations' ORDER BY type,name",
    )
    .all()
    .map((row) => ({ type: String(row.type), name: String(row.name), sql: row.sql === null ? null : String(row.sql) }));
}

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Random ids (directory source, cursors, tickets) become their first-seen ordinal. */
function normalize(value: unknown): unknown {
  const seen = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value).replace(uuid, (id) => {
      if (!seen.has(id)) seen.set(id, `uuid-${seen.size + 1}`);
      return seen.get(id)!;
    }),
  );
}
function recorder() {
  const steps: [string, unknown][] = [];
  const record = (label: string, value: unknown) => steps.push([label, value === undefined ? null : value]);
  const failed = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });
  return {
    steps,
    step(label: string, work: () => unknown) {
      try {
        record(label, work());
      } catch (error) {
        record(label, failed(error));
      }
    },
    async stepAsync(label: string, work: () => Promise<unknown>) {
      try {
        record(label, await work());
      } catch (error) {
        record(label, failed(error));
      }
    },
  };
}

type SourceThread = { id: string; updatedAt: number; cwd: string; preview: string; name?: string; status: unknown };
const thread = (id: string, updatedAt: number, name?: string): SourceThread => ({
  id,
  updatedAt,
  cwd: "/workspace",
  preview: `preview ${id}`,
  ...(name ? { name } : {}),
  status: { type: "idle" },
});

/** Pull, page, observe, flush, snapshot, search, count and a rolled-back chunk, in the order Host owners drive them. */
async function directoryScenario(database: SqlDatabase, local: boolean) {
  let clock = 1_700_000_000_000;
  const source = new Map<string, SourceThread>();
  const archived = new Set<string>();
  const refused = new Set<string>();
  const events: unknown[] = [];
  for (const [index, id] of ["a", "b", "c", "d"].entries())
    source.set(id, thread(id, 1_000 + index, id === "a" ? "Alpha" : id === "b" ? "Beta" : undefined));
  source.set("z", thread("z", 900, "Zeta"));
  archived.add("z");
  const port: ThreadDirectoryPort = {
    async list(params) {
      const rows = [...source.values()]
        .filter((row) => archived.has(row.id) === (params.archived === true))
        .sort((x, y) => y.updatedAt - x.updatedAt || x.id.localeCompare(y.id));
      const offset = params.cursor ? Number(params.cursor) : 0;
      const limit = Math.min(Number(params.limit ?? 200), 3);
      return {
        data: rows.slice(offset, offset + limit),
        nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
      };
    },
    async readMetadata(threadId) {
      return { thread: source.get(threadId) ?? null };
    },
    changed: (event) => events.push(event ?? null),
    project: (row) => {
      if (refused.has(row.id)) throw new Error("projection refused");
      return row;
    },
    ...(local ? { connectionLocalExecution: true } : {}),
  };
  const directory = new SqlThreadDirectory({ database }, port, () => clock, 3_600_000);
  const { steps, step, stepAsync } = recorder();
  const ids = (page: { data: { id: string; name?: string | null; status?: unknown }[] }) =>
    page.data.map((row) => [row.id, row.name ?? null, row.status ?? null]);
  const query = { sortKey: "updated_at", limit: 2 };
  try {
    await stepAsync("cold list refreshes", async () => {
      const page = await directory.list(query);
      return { rows: ids(page), next: page.nextCursor, catalog: page.catalog };
    });
    await stepAsync("second page", async () => {
      const first = await directory.list(query);
      const page = await directory.list({ ...query, cursor: first.nextCursor });
      return { rows: ids(page), next: page.nextCursor };
    });
    await stepAsync("archived", async () => ids(await directory.list({ ...query, archived: true })));
    step("unsupported query", () => directory.supports({ sortKey: "created_at" }));
    await stepAsync("rename observed", async () => {
      directory.observe("thread/name/updated", { threadId: "c", name: "Gamma" });
      return ids(await directory.list({ ...query, limit: 10 }));
    });
    await stepAsync("dirty flush reads metadata", async () => {
      clock += 1_000;
      source.set("b", { ...thread("b", 5_000, "Beta two") });
      directory.markDirty("b");
      await directory.flush();
      return ids(await directory.list({ ...query, limit: 10 }));
    });
    if (local)
      step("execution status is connection-local", () => {
        directory.observe("turn/started", { threadId: "a", turn: { id: "turn-1" } });
        return database.prepare("SELECT metadata_json FROM opencraft_thread_catalog WHERE thread_id='a'").get();
      });
    await stepAsync("delete observed", async () => {
      directory.observe("thread/deleted", { threadId: "d" });
      return ids(await directory.list({ ...query, limit: 10 }));
    });
    await stepAsync("snapshot pages", async () => {
      const first = await directory.list({ ...query, cursor: SNAPSHOT_START });
      const second = await directory.list({ ...query, cursor: first.nextCursor });
      return [ids(first), ids(second), first.catalog];
    });
    step("name search", () => {
      const window = directory.searchNames({ kind: "window", query: "a", cursor: null });
      return { entries: window.entries, position: window.fence.position, observedAt: window.observedAt };
    });
    step("count, validate", () => {
      const read = directory.countRead({ kind: "capture" }, "scope", () => {});
      if (read.status !== "complete") return read;
      return [read.ids, directory.countRead({ kind: "validate", ticket: read.ticket }, "scope", () => {})];
    });
    step("count invalidated by a later write", () => {
      const read = directory.countRead({ kind: "capture" }, "scope", () => {});
      directory.observe("thread/name/updated", { threadId: "a", name: "Alpha two" });
      return read.status === "complete"
        ? directory.countRead({ kind: "validate", ticket: read.ticket }, "scope", () => {})
        : read;
    });
    step("count invalidated by another write on the connection", () => {
      const read = directory.countRead({ kind: "capture" }, "scope", () => {});
      database.prepare("INSERT INTO opencraft_threads(id,document) VALUES('other','{}')").run();
      return read.status === "complete"
        ? directory.countRead({ kind: "validate", ticket: read.ticket }, "scope", () => {})
        : read;
    });
    await stepAsync("a failing chunk rolls back as one transaction", async () => {
      clock += 1_000;
      source.set("e", thread("e", 6_000));
      source.set("f", thread("f", 6_001));
      refused.add("f");
      const outcome = await directory.refresh().then(
        () => "ok",
        (error: Error) => error.message,
      );
      return [
        outcome,
        database.prepare("SELECT count(*) AS n FROM opencraft_thread_catalog WHERE thread_id IN ('e','f')").get(),
      ];
    });
    await stepAsync("recovers once the source is valid", async () => {
      clock += 1_000;
      refused.clear();
      await directory.refresh();
      return ids(await directory.list({ ...query, limit: 10 }));
    });
    step("rows", () =>
      database
        .prepare(
          "SELECT thread_id,metadata_json,updated_at,archived,observed_at_ms,revision,deleted FROM opencraft_thread_catalog ORDER BY thread_id",
        )
        .all(),
    );
    step("sync state", () => database.prepare("SELECT * FROM opencraft_catalog_sync ORDER BY archived").all());
    step("events", () => events);
  } finally {
    directory.close();
  }
  return normalize(steps);
}

/** AES-256-GCM like the Node owner's cipher, on a fixed test key so a restarted object can read its rows. */
export function testVaultCipher(): GitVaultCipher {
  let key: Uint8Array | null = new Uint8Array(32).map((_, index) => index + 1);
  const live = () => {
    if (!key) throw new Error("vault closed");
    return key;
  };
  return {
    seal(aad, clear) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", live(), iv);
      cipher.setAAD(aad);
      const body = cipher.update(clear),
        last = cipher.final(),
        tag = cipher.getAuthTag();
      const out = new Uint8Array(12 + body.length + last.length + 16);
      out.set(iv, 0);
      out.set(body, 12);
      out.set(last, 12 + body.length);
      out.set(tag, 12 + body.length + last.length);
      return out;
    },
    open(aad, sealed) {
      const decipher = createDecipheriv("aes-256-gcm", live(), sealed.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const body = decipher.update(sealed.subarray(12, sealed.length - 16)),
        last = decipher.final();
      const out = new Uint8Array(body.length + last.length);
      out.set(body, 0);
      out.set(last, body.length);
      return out;
    },
    grantAuthority: (mode) => createHmac("sha256", live()).update(`authority:${mode}`).digest("hex"),
    sealGrant: (scope) => `grant:${scope.account}:${scope.threadId}`,
    dispose() {
      key?.fill(0);
      key = null;
    },
  };
}

const credential = (token: string): GitVaultCredential => ({
  identity: { username: "octo", name: "Octo Cat", email: "octo@example.com" },
  token,
  signing: null,
});
/** Rows, revisions, tombstones, namespaces, envelopes and transaction rollback. */
function vaultScenario(database: SqlDatabase) {
  const vault = new EmployeeGitVault(database, testVaultCipher());
  const { steps, step } = recorder();
  step("empty", () => vault.status("employee:1", "github.com"));
  step("write", () => vault.write("employee:1", "github.com", 0, credential("token-1")));
  step("stale revision conflicts", () => vault.write("employee:1", "github.com", 0, credential("token-2")));
  step("read", () => vault.read("employee:1", "github.com"));
  step("invalid credential", () =>
    vault.write("employee:1", "github.com", 1, {
      ...credential("x"),
      identity: { username: "", name: "", email: "bad" },
    }),
  );
  step("invalid host", () => vault.read("employee:1", "GitHub.com"));
  step("bindings", () => [vault.hasBindings("github.com"), vault.hasBindings("gitlab.com")]);
  step("secret", () => [
    vault.writeSecret("employee:1", "model-service", 0, "secret-1"),
    vault.readSecret("employee:1", "model-service"),
  ]);
  step("invalid secret", () => vault.writeSecret("employee:1", "model-service", 1, "line\nbreak"));
  step("document", () => {
    vault.writeDocument("employee:1", "document-environment", 0, { variables: { A: "1" } });
    return vault.readDocument("employee:1", "document-environment");
  });
  step("document namespace", () => vault.readDocument("employee:1", "environment"));
  step("delete keeps a tombstone", () => vault.write("employee:1", "github.com", 1, null));
  step("revision zero cannot resurrect", () => vault.write("employee:1", "github.com", 0, credential("token-3")));
  step("bindings after delete", () => vault.hasBindings("github.com"));
  step("execution context round trip", () =>
    vault.openExecutionContext(vault.sealExecutionContext({ version: 1, scope: { account: "employee:1" } })),
  );
  step("tampered envelope", () => {
    const envelope = vault.sealExecutionContext({ version: 1 });
    return vault.openExecutionContext(envelope.slice(0, -2) + (envelope.endsWith("AA") ? "BA" : "AA"));
  });
  step("non-canonical envelope", () => vault.openExecutionContext("A"));
  step("a row moved to another key does not open", () => {
    database
      .prepare(
        "UPDATE employee_git_credentials SET host='other-service' WHERE account='employee:1' AND host='model-service'",
      )
      .run();
    try {
      vault.readSecret("employee:1", "other-service");
      return "opened";
    } catch {
      // The cipher's own message differs between runtimes; only the refusal is compared.
      return "refused";
    } finally {
      database
        .prepare(
          "UPDATE employee_git_credentials SET host='model-service' WHERE account='employee:1' AND host='other-service'",
        )
        .run();
    }
  });
  step("outer rollback discards the write", () => {
    try {
      database.transaction(() => {
        vault.write("employee:2", "github.com", 0, credential("token-4"));
        throw new Error("abort");
      });
    } catch (error) {
      return [(error as Error).message, vault.status("employee:2", "github.com").revision];
    }
  });
  step("rows", () =>
    database
      .prepare(
        "SELECT account,host,revision,credential IS NULL AS cleared FROM employee_git_credentials ORDER BY account,host",
      )
      .all(),
  );
  vault.close();
  step("closed", () => vault.readSecret("employee:1", "model-service"));
  return normalize(steps);
}

export async function scenario(database: SqlDatabase, name: WorkspaceScenario): Promise<unknown> {
  switch (name) {
    case "directory-remote":
      return directoryScenario(database, false);
    case "directory-local":
      return directoryScenario(database, true);
    case "vault":
      return vaultScenario(database);
  }
}

/** Restart probe: writes on the first instance, reads on the next one over the same storage. */
export function vaultWrite(database: SqlDatabase) {
  const vault = new EmployeeGitVault(database, testVaultCipher());
  try {
    return vault.write("employee:restart", "github.com", 0, credential("kept")).revision;
  } finally {
    vault.close();
  }
}
export function vaultRead(database: SqlDatabase) {
  const vault = new EmployeeGitVault(database, testVaultCipher());
  try {
    return vault.read("employee:restart", "github.com");
  } finally {
    vault.close();
  }
}
