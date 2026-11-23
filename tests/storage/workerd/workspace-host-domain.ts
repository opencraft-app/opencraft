// WorkspaceHost stores over the runtime-neutral SQL port, shared by the
// Node test (tests/storage/workspace-host-sql-port.test.ts, nodeSqlDatabase)
// and the Durable Object prototype (workspace-host-worker.ts, bundled for
// workerd). Each store keeps its own published migration chain and ledger, so
// each runs on its own database; every scenario returns plain JSON with
// clocks and random ids normalized, so both runtimes are compared result for
// result. See docs/architecture/platform/workspace-host-split.md §4.1.
import { createHash } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";
import { applySqlMigrations, hashSqlMigrations, type SqlMigration } from "@opencraft/sql/migrations";
import { resolveStoreMigrations, type StorageSchemaId } from "@opencraft/sqlite-node";
import { CONVERSATION_SCHEDULE_MIGRATIONS, SqlConversationSchedules } from "@opencraft/host-schedules";
import {
  INTERRUPTED_TURN_RECOVERY_MIGRATIONS,
  PROVIDER_TURN_RETRY_MIGRATIONS,
  SqlInterruptedTurnRecovery,
  SqlProviderTurnRetry,
} from "@opencraft/host-recovery";
import { OPENCRAFT_HOST_STATE_MIGRATIONS } from "../../../apps/opencraft-daemon/src/opencraft-host-state-database.ts";
import { PROVISIONAL_THREAD_MIGRATIONS, SqlProvisionalThreads } from "../../../apps/opencraft-daemon/src/provisional-threads.ts";
import { SqlHostQueue } from "../../../apps/opencraft-daemon/src/opencraft-host-queue.ts";
import { ExecutionLeaseStore } from "../../../apps/opencraft-daemon/src/execution-lease-store.ts";
import { OpenCraftMessageSenders } from "../../../apps/opencraft-daemon/src/opencraft-message-senders.ts";

/** WorkspaceHost SQLite stores today, by `openManagedDatabase` schema id (registry appends generated migrations). */
const PUBLISHED: Record<WorkspaceHostStore, { id: StorageSchemaId; prefix: readonly SqlMigration[] }> = {
  "opencraft-host-state": { id: "opencraft-host-state-database", prefix: OPENCRAFT_HOST_STATE_MIGRATIONS },
  "thread-creations": { id: "provisional-threads", prefix: PROVISIONAL_THREAD_MIGRATIONS },
  "conversation-schedules": { id: "host-schedules", prefix: CONVERSATION_SCHEDULE_MIGRATIONS },
  "interrupted-turn-recovery": { id: "host-recovery", prefix: INTERRUPTED_TURN_RECOVERY_MIGRATIONS },
  "provider-turn-retry": { id: "provider-retry", prefix: PROVIDER_TURN_RETRY_MIGRATIONS },
};
export type WorkspaceHostStore =
  | "opencraft-host-state"
  | "thread-creations"
  | "conversation-schedules"
  | "interrupted-turn-recovery"
  | "provider-turn-retry";
export const WORKSPACE_HOST_STORES = Object.keys(PUBLISHED) as WorkspaceHostStore[];

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** The full published chain the Node owner applies, with the checksums its ledger records. */
export function publishedMigrations(store: WorkspaceHostStore) {
  const { id, prefix } = PUBLISHED[store];
  return hashSqlMigrations(resolveStoreMigrations(id, prefix), sha256Hex);
}

/** Applies the chain through the runtime-neutral ledger runner; returns the ledger without timestamps. */
export function migrate(database: SqlDatabase, store: WorkspaceHostStore, limit?: number) {
  const migrations = publishedMigrations(store);
  applySqlMigrations(database, limit === undefined ? migrations : migrations.slice(0, limit));
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
    .map((row) => ({ type: String(row.type), name: String(row.name), table: String(row.tbl_name), sql: row.sql === null ? null : String(row.sql) }));
}

const lent = (database: SqlDatabase) => ({ database, close() {} });
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Wall-clock lease times differ per run; only their presence is compared. */
const WALL_CLOCK = new Set(["admittedAtMs", "endedAtMs"]);
/** Random ids become stable placeholders by first appearance. */
function normalize(value: unknown): unknown {
  const seen = new Map<string, string>();
  return JSON.parse(JSON.stringify(value), (key, item) =>
    WALL_CLOCK.has(key) && typeof item === "number" ? "wall-clock"
      : typeof item === "string" ? item.replace(uuid, (id) => seen.get(id) ?? (seen.set(id, `uuid-${seen.size + 1}`), `uuid-${seen.size}`)) : item,
  );
}
const attempt = (action: () => unknown) => {
  try {
    return { ok: true, value: action() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/** Key operations of each store, in the order the Codex engine adapter drives them. */
export async function scenario(database: SqlDatabase, store: WorkspaceHostStore): Promise<unknown> {
  const steps: Record<string, unknown> = {};
  if (store === "opencraft-host-state") {
    // Queue, input delivery, execution leases and senders share the Host state connection.
    const queue = new SqlHostQueue(database);
    const leases = new ExecutionLeaseStore(database, () => null);
    const first = queue.add("t", "c1", [{ type: "text", text: "one" }]);
    const second = queue.add("t", "c2", [{ type: "text", text: "two" }]);
    steps.duplicate = attempt(() => queue.add("t", "c1", [{ type: "text", text: "changed" }]));
    queue.reorder("t", [second.id, first.id]);
    steps.order = queue.list("t", []).map((row) => row.clientUserMessageId);
    const claimed = queue.claim("t", second.id, null)!;
    steps.claimed = { state: claimed.state, delivery: claimed.delivery };
    steps.settled = queue.settle("t", second.id, "steering", null, "turn-1");
    steps.finished = queue.deliveries.finish("t", "turn-1", "completed");
    steps.counts = queue.maintenanceCounts();
    steps.pending = queue.pendingThreads();
    steps.outcomes = queue.inputOutcomes("t");
    steps.awaiting = queue.firstAwaitingAdmission("t")?.clientUserMessageId ?? null;
    // A failing write inside an outer transaction rolls back only its savepoint.
    steps.nested = database.transaction(() => {
      const inner = attempt(() => database.transaction(() => {
        queue.add("t", "c3", [{ type: "text", text: "three" }]);
        throw new Error("abort inner");
      }));
      return { inner, rolledBack: queue.findByClientId("t", "c3") === null };
    });
    const executionId = leases.begin("t", "start-1", "engine-a");
    leases.started("t", "turn-2", "start-1", "engine-a");
    steps.active = leases.resolve({ threadId: "t", executionId });
    steps.submission = leases.getSubmission("t", "c1");
    leases.finished("t", "turn-2");
    steps.ended = leases.resolve({ threadId: "t", executionId }).status;
    leases.observedStart("t", "turn-3", "engine-a");
    steps.unsettled = leases.unsettledTargets("t");
    leases.suspend();
    steps.suspended = leases.unsettledThreads();
    const senders = new OpenCraftMessageSenders(database);
    senders.record("t", "c1", { kind: "employee", loginName: "alice" } as never);
    steps.reattribute = attempt(() => senders.record("t", "c1", null));
    senders.cloneThread("t", "fork");
    steps.senders = { forked: senders.get("fork", "c1"), inherited: senders.isInherited("fork", "c1"), employees: senders.hasEmployees("fork") };
  } else if (store === "thread-creations") {
    const threads = new SqlProvisionalThreads(lent(database));
    const thread = { id: "t", cwd: "/w", updatedAt: 1, createdAt: 1, preview: "", status: { type: "idle" } };
    threads.created("t", { thread }, "environment-a");
    threads.attempted("t", "input-1");
    threads.accepted("t", "input-1", "turn-1");
    steps.accepted = threads.get("t");
    threads.catalog.allocate({ ...thread, id: "u" } as never);
    threads.catalog.accept("u", "turn-u");
    steps.catalog = { u: threads.catalog.read("u"), committed: threads.catalog.committed() };
    threads.catalog.retire("gone", true);
    threads.persisted("t");
    steps.persisted = threads.get("t")?.phase;
    steps.gone = threads.get("gone");
    threads.close();
  } else if (store === "conversation-schedules") {
    const now = 1_800_000_000_000;
    const schedules = new SqlConversationSchedules(
      lent(database),
      {
        validate: async () => {},
        submit: async () => ({ state: "running", turnId: "turn-s" }),
        inspect: async () => ({ state: "completed", turnId: "turn-s" }),
      },
      () => now,
      () => {},
      () => {},
      () => true,
      () => ({ arm() {}, cancel() {} }),
    );
    const save = { threadId: "t", expectedRevision: 0, prompt: "check", nextRunAt: now + 60_000, intervalMinutes: 60, timeZone: "UTC" };
    steps.saved = (await schedules.handle("opencraft/schedules/save", save, "alice")).schedule;
    steps.conflict = await schedules.handle("opencraft/schedules/save", save, "alice").then(() => "saved", (error: Error) => error.message);
    steps.runNow = (await schedules.handle("opencraft/schedules/action", { threadId: "t", expectedRevision: 1, action: "run-now" }, "alice")).runs;
    schedules.suspend("t");
    steps.suspended = schedules.read("t");
    steps.list = schedules.list();
    steps.permissions = schedules.executionPermissions("t", "schedule:missing");
    await schedules.close();
  } else if (store === "interrupted-turn-recovery") {
    const recovery = new SqlInterruptedTurnRecovery(lent(database), {
      inspect: async () => "unknown",
      serialize: (_threadId, operation) => operation(),
      continue: async () => null,
      changed: () => {},
    });
    recovery.started("t", "turn-1");
    recovery.started("u", "turn-u");
    recovery.lost("t");
    recovery.finished("u", "turn-u");
    steps.snapshot = recovery.snapshot("t");
    steps.pending = recovery.pendingThreadIds();
    steps.handoff = recovery.handoffObservation();
    recovery.handled("t", "user_stop");
    steps.handled = { snapshot: recovery.snapshot("t"), notice: recovery.notice("t") };
    await recovery.close();
  } else {
    const now = 1_800_000_000_000;
    const retry = new SqlProviderTurnRetry(
      lent(database),
      {
        serialize: (_threadId, work) => work(),
        inspect: async () => "unknown",
        continue: async () => null,
        changed: () => {},
      },
      () => now,
      () => 0.5,
      () => true,
    );
    retry.failed("t", "turn-1", { kind: "overloaded" });
    steps.waiting = { snapshot: retry.snapshot("t"), notice: retry.notice("t"), pending: retry.pendingThreadIds() };
    retry.failed("u", "turn-u", { kind: "permanent" });
    steps.permanent = retry.snapshot("u");
    retry.handled("t");
    steps.handled = { snapshot: retry.snapshot("t"), notice: retry.notice("t"), pending: retry.pendingThreadIds() };
    await retry.close();
  }
  return normalize(steps);
}
