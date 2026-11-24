// Plugin and extension stores over the runtime-neutral SQL port (gateway-split.md
// §4.2 storage row, storage-ports.md §3.7): login admission, thread
// participants, tasks and extension documents. Shared by the Durable Object
// prototype (extension-stores-worker.ts, bundled for workerd) and the Node side
// of the scenarios (nodeSqlDatabase). Each store runs on its own database with
// its owner's published migration chain; thread participants run on the thread
// identity chain whose owner holds their tables. Every scenario returns plain
// JSON with random ids normalized, so both runtimes are compared step by step.
import { createHash } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";
import { applySqlMigrations, hashSqlMigrations, type SqlMigration } from "@opencraft/sql/migrations";
import { resolveStoreMigrations, type StorageSchemaId } from "@opencraft/sqlite-node";
import { LOGIN_ADMISSION_MIGRATIONS, SqlLoginAdmissionStore } from "../../../plugins/login-admission/src/sql-store.ts";
import { SqlParticipantStore } from "../../../plugins/thread-participants/src/sql-participant-store.ts";
import { SqlTasksStore, TASKS_MIGRATIONS } from "../../../plugins/tasks/src/sqlite.ts";
import { DOCUMENT_STORAGE_MIGRATIONS, SqlDocumentStore } from "../../../packages/document-storage/src/sqlite.ts";
import { THREAD_IDENTITY_SCHEMA } from "../../../apps/opencraft-daemon/src/thread-identity-database.ts";
import {
  OPENCRAFT_HOST_EXECUTION_BOOT_CLOCK,
  OPENCRAFT_HOST_EXECUTION_LEASES,
} from "../../../apps/opencraft-daemon/src/execution-lease-schema.ts";

/** Each store by its `openManagedDatabase` schema id (the registry appends generated migrations). */
const PUBLISHED: Record<ExtensionStore, { id: StorageSchemaId; prefix: readonly SqlMigration[] }> = {
  "login-admission": { id: "login-admission", prefix: LOGIN_ADMISSION_MIGRATIONS },
  "thread-participants": {
    id: "thread-identity-database",
    prefix: [
      { version: 1, name: "thread-identity", sql: THREAD_IDENTITY_SCHEMA },
      { version: 2, name: "immutable-execution-leases", sql: OPENCRAFT_HOST_EXECUTION_LEASES },
      { version: 3, name: "execution-boot-clock", sql: OPENCRAFT_HOST_EXECUTION_BOOT_CLOCK },
    ],
  },
  tasks: { id: "tasks", prefix: TASKS_MIGRATIONS },
  "document-storage": { id: "document-storage", prefix: DOCUMENT_STORAGE_MIGRATIONS },
};
export type ExtensionStore = "login-admission" | "thread-participants" | "tasks" | "document-storage";
export const EXTENSION_STORES = Object.keys(PUBLISHED) as ExtensionStore[];

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** The full published chain the Node owner applies, with the checksums its ledger records. */
export function publishedMigrations(store: ExtensionStore) {
  const { id, prefix } = PUBLISHED[store];
  return hashSqlMigrations(resolveStoreMigrations(id, prefix), sha256Hex);
}

/** Applies the chain through the runtime-neutral ledger runner; returns the ledger without timestamps. */
export function migrate(database: SqlDatabase, store: ExtensionStore) {
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
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type,name",
    )
    .all()
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
      sql: row.sql === null ? null : String(row.sql),
    }));
}

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Random ids become their first-seen ordinal, so equal ids stay equal across runtimes. */
function normalize(value: unknown): unknown {
  const seen = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value).replace(uuid, (id) => {
      if (!seen.has(id)) seen.set(id, `uuid-${seen.size + 1}`);
      return seen.get(id)!;
    }),
  );
}
/** Runs each step and records its value or error. */
function recorder() {
  const steps: [string, unknown][] = [];
  return {
    steps,
    step(label: string, work: () => unknown) {
      try {
        const value = work();
        steps.push([label, value === undefined ? null : value]);
      } catch (error) {
        steps.push([
          label,
          {
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            // Protocol faults (for example TasksFault) carry a JSON-RPC code.
            code: (error as { code?: unknown } | null)?.code ?? null,
          },
        ]);
      }
    },
  };
}
/** Runs `work` in an outer transaction that then fails, so every write inside must roll back. */
function abandoned(database: SqlDatabase, work: () => unknown): string {
  try {
    database.transaction(() => {
      work();
      throw new Error("abandoned");
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "committed";
}

function loginAdmissionScenario(database: SqlDatabase) {
  const store = new SqlLoginAdmissionStore(database);
  const { steps, step } = recorder();
  const rules = (list: string[]) => JSON.stringify({ enabled: true, allowlist: list });
  step("empty", () => store.load("hub"));
  step("publish", () => store.publish("hub", 0, rules(["alice"]), "admin", 10, "first"));
  step("stale publish", () => store.publish("hub", 0, rules(["mallory"]), "admin", 11, "stale"));
  step("publish again", () => store.publish("hub", 1, rules(["alice", "bob"]), "root", 12, "second"));
  step("identity", () => store.recordIdentity("hub", "subject-b", '{"login":"bob"}', 13));
  step("identity unchanged keeps seen_at", () => store.recordIdentity("hub", "subject-b", '{"login":"bob"}', 14));
  step("identity changed", () => store.recordIdentity("hub", "subject-b", '{"login":"robert"}', 15));
  step("seen_at", () =>
    database.prepare("SELECT subject,seen_at FROM login_admission_identities ORDER BY policy,subject").all(),
  );
  step("import over a published policy keeps it", () =>
    store.importPolicy(
      "hub",
      "legacy",
      rules(["carol"]),
      [
        { subject: "subject-b", attributes: '{"login":"ignored"}' },
        { subject: "subject-c", attributes: '{"login":"carol"}' },
      ],
      "import",
      16,
      "legacy",
    ),
  );
  step("import twice", () => store.importPolicy("hub", "legacy", rules(["carol"]), [], "import", 17, "legacy"));
  step("import into an empty policy", () =>
    store.importPolicy("other", "legacy", rules(["dave"]), [], "import", 18, "legacy"),
  );
  step("abandoned publish rolls back", () =>
    abandoned(database, () => store.publish("other", 1, rules(["eve"]), "admin", 19, "abandoned")),
  );
  step("load", () => store.load("hub"));
  step("load other", () => store.load("other"));
  step("history", () => store.history("hub", 10));
  step("bounded history", () => store.history("hub", 0));
  step("audit detail", () =>
    database.prepare("SELECT policy,revision,action,detail FROM login_admission_audit ORDER BY id").all(),
  );
  return normalize(steps);
}

function participantsScenario(database: SqlDatabase) {
  // Senders and inherited origins are written by the thread identity owner.
  const sender = database.prepare("INSERT INTO message_senders VALUES(?,?,?,?)");
  sender.run("t1", "m1", JSON.stringify({ kind: "employee", loginName: "alice" }), 1);
  sender.run("t1", "m2", JSON.stringify({ kind: "employee", loginName: "bob" }), 2);
  sender.run("t1", "m3", JSON.stringify({ kind: "bot", loginName: "robot" }), 3);
  sender.run("t1", "m4", "not json", 4);
  sender.run("t1", "m5", JSON.stringify({ kind: "employee", loginName: "carol" }), 5);
  database.prepare("INSERT INTO message_sender_origins VALUES(?,?,?)").run("t1", "m5", "t0");
  database.prepare("INSERT INTO ioa_presence_sync VALUES(?,?)").run("t1", 9);
  const store = new SqlParticipantStore(database);
  const { steps, step } = recorder();
  step("load empty", () => store.load(["t1", "t2"]));
  step("creator", () => store.recordCreator("t1", "alice"));
  step("creator kept", () => store.recordCreator("t1", "bob"));
  step("anonymous creator", () => store.recordCreator("t2", null));
  step("invalid creator", () => store.recordCreator("t3", "not a name!"));
  step("apply", () => store.apply("t1", ["m1", "m2", "m3", "m4", "m5", "missing"], false));
  step("apply again is unchanged", () => store.apply("t1", ["m1"], false));
  step("replace", () => store.apply("t1", ["m2"], true));
  step("abandoned apply rolls back", () => abandoned(database, () => store.apply("t1", ["m1"], true)));
  step("after abandoned", () => store.load(["t1"]));
  step("forget", () => store.forget("t1"));
  step("forget again", () => store.forget("t1"));
  step("presence sync cleared", () => database.prepare("SELECT count(*) AS n FROM ioa_presence_sync").get());
  step("reused id", () => store.recordCreator("t1", "dave"));
  return normalize(steps);
}

function tasksScenario(database: SqlDatabase) {
  let clock = 1_000_000;
  const store = new SqlTasksStore(database, () => clock);
  const { steps, step } = recorder();
  const revision = (id: string) => store.read(id).revision;
  const recycled = (id: string) => store.list().recycled.find((task) => task.id === id)?.revision ?? 0;
  const content = { title: "Ship", description: "Port", projectServerId: null, projectId: null };
  const actor = { actor: { kind: "human", id: "alice" }, channel: "api" } as never;
  step("member", () =>
    store.member({ id: "m1", name: "Alice", expectedRevision: null, identity: { kind: "human", id: "alice" } }),
  );
  step("member conflict", () => store.member({ id: "m1", name: "Alicia", expectedRevision: null }));
  step("create", () =>
    store.create({ ...content, id: "a", status: "todo", assigneeId: "m1", kind: "feature" } as never, actor),
  );
  step("create again is idempotent", () => store.create({ ...content, id: "a", status: "todo" }));
  step("create conflict", () => store.create({ ...content, title: "Other", id: "a", status: "todo" }));
  step("unknown assignee", () => store.create({ ...content, id: "x", status: "todo", assigneeId: "nobody" } as never));
  clock += 1;
  step("create b", () => store.create({ ...content, id: "b", status: "todo" }));
  step("update", () => store.update({ ...content, title: "Ship it", id: "a", expectedRevision: revision("a") }, actor));
  step("stale update", () => store.update({ ...content, id: "a", expectedRevision: 1 }));
  step("move", () => store.move({ id: "b", expectedRevision: revision("b"), status: "todo", beforeId: "a" }));
  step("move to review", () =>
    store.move({ id: "a", expectedRevision: revision("a"), status: "in_review", beforeId: null }),
  );
  step("properties", () =>
    store.properties({ id: "a", expectedRevision: revision("a"), priority: "high", dueDate: "2026-12-01" } as never),
  );
  step("attach", () => store.attach({ id: "a", expectedRevision: revision("a"), serverId: "s", threadId: "t" }));
  step("attach again", () => store.attach({ id: "a", expectedRevision: 1, serverId: "s", threadId: "t" }));
  step("for conversation", () => store.forConversation("s", "t"));
  step("progress", () => store.progress({ taskId: "a", eventId: "e1", text: "half" }));
  step("progress again", () => store.progress({ taskId: "a", eventId: "e1", text: "half" }));
  step("progress conflict", () => store.progress({ taskId: "a", eventId: "e1", text: "other" }));
  step("detach", () => store.detach({ id: "a", expectedRevision: revision("a"), serverId: "s", threadId: "t" }));
  step("abandoned update rolls back", () =>
    abandoned(database, () => store.update({ ...content, title: "Lost", id: "a", expectedRevision: revision("a") })),
  );
  clock += 1;
  step("archive", () => store.archive({ id: "b", expectedRevision: revision("b") }, true));
  step("archives", () => store.archives({ search: "", limit: 1 }));
  step("unarchive", () => store.archive({ id: "b", expectedRevision: store.read("b").revision }, false));
  step("remove", () => store.remove({ id: "b", expectedRevision: revision("b") }));
  step("restore", () => store.restore({ id: "b", expectedRevision: recycled("b") }));
  step("remove again", () => store.remove({ id: "b", expectedRevision: revision("b") }));
  step("events", () => store.events({ taskId: "a", limit: 3 }));
  step("event", () => store.event("a", "e1"));
  step("missing task", () => store.read("missing"));
  clock += 8 * 86_400_000;
  step("recycle expired", () => store.restore({ id: "b", expectedRevision: recycled("b") }));
  step("list", () => store.list());
  step("foreign key", () => {
    try {
      database.prepare("INSERT INTO task_conversations VALUES('nobody','s','t',0)").run();
      return "accepted";
    } catch {
      return "refused";
    }
  });
  return normalize(steps);
}

function documentsScenario(database: SqlDatabase) {
  const store = new SqlDocumentStore(database);
  const { steps, step } = recorder();
  step("empty", () => store.read("plugin.example/settings"));
  step("create", () => store.compareAndSet("plugin.example/settings", 0, 1, { theme: "dark" }));
  step("stale", () => store.compareAndSet("plugin.example/settings", 0, 1, { theme: "light" }));
  step("update", () => store.compareAndSet("plugin.example/settings", 1, 2, { theme: "light", size: [1, 2] }));
  step("downgrade", () => store.compareAndSet("plugin.example/settings", 2, 1, {}));
  step("invalid scope", () => store.compareAndSet("bad scope", 0, 1, {}));
  step("not JSON", () => store.compareAndSet("plugin.example/other", 0, 1, { at: new Date(0) }));
  step("abandoned write rolls back", () =>
    abandoned(database, () => store.compareAndSet("plugin.example/settings", 2, 2, { lost: true })),
  );
  step("read", () => store.read("plugin.example/settings"));
  return normalize(steps);
}

export function scenario(database: SqlDatabase, store: ExtensionStore) {
  switch (store) {
    case "login-admission":
      return loginAdmissionScenario(database);
    case "thread-participants":
      return participantsScenario(database);
    case "tasks":
      return tasksScenario(database);
    case "document-storage":
      return documentsScenario(database);
  }
}

/** Writes one durable value per store, read back after a runtime restart. */
export function seed(database: SqlDatabase, store: ExtensionStore): unknown {
  switch (store) {
    case "login-admission":
      return new SqlLoginAdmissionStore(database).publish("hub", 0, '{"enabled":false}', "admin", 1, "seed");
    case "thread-participants":
      return new SqlParticipantStore(database).recordCreator("kept", "alice").changed;
    case "tasks":
      return new SqlTasksStore(database, () => 1).create({
        title: "Kept",
        description: "",
        projectServerId: null,
        projectId: null,
        id: "kept",
        status: "todo",
      }).tasks.length;
    case "document-storage":
      return new SqlDocumentStore(database).compareAndSet("plugin.example/kept", 0, 1, { kept: true }).updated;
  }
}
export function readBack(database: SqlDatabase, store: ExtensionStore): unknown {
  switch (store) {
    case "login-admission":
      return new SqlLoginAdmissionStore(database).load("hub");
    case "thread-participants":
      return new SqlParticipantStore(database).load(["kept"]);
    case "tasks":
      return new SqlTasksStore(database, () => 2).read("kept").title;
    case "document-storage":
      return new SqlDocumentStore(database).read("plugin.example/kept");
  }
}
