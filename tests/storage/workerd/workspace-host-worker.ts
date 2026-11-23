// WorkspaceHost store prototype on Durable Object SQL (workspace-host-split.md
// §3.1, §4.1). One SQLite-backed object per (workspace, store): each store keeps
// its own published migration chain and `schema_migrations` ledger, so they
// cannot share one object's database until the §4.1 merge migration exists.
// The object migrates through the runtime-neutral ledger runner and runs the
// unchanged domain stores over `durableObjectSqlDatabase`. Bundled with esbuild
// (nodejs_compat) and driven through Miniflare by
// tests/storage/workspace-host-workerd.test.ts. The recovery and provider-retry
// owners also run on an alarm-backed OwnerWakeTimer (§4.3): the owner arms the
// object's single alarm and the alarm handler — possibly on a fresh instance —
// reopens the owner over the same SQL and lets it decide from durable rows.
// Test-only: no WorkspaceHost assembly or sandbox endpoint yet.
import { DurableObject } from "cloudflare:workers";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import type { OwnerWakeTimer } from "@opencraft/workspace-host";
import { SqlInterruptedTurnRecovery, SqlProviderTurnRetry } from "@opencraft/host-recovery";
import { ledger, migrate, scenario, schema, type WorkspaceHostStore } from "./workspace-host-domain.js";

interface Env {
  readonly STORE: {
    idFromName(name: string): unknown;
    get(id: unknown): WorkspaceHostStoreObject;
  };
}
type Method =
  "migrate" | "ledger" | "schema" | "scenario" | "tamperLedger" | "seed" | "engineWake" | "observe" | "evict";
type AlarmStore = "interrupted-turn-recovery" | "provider-turn-retry";
interface AlarmStorage {
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
/** OwnerWakeTimer over the object's alarm: `at` is the owner's wall clock, as an alarm time is. */
function alarmWakeTimer(storage: AlarmStorage): OwnerWakeTimer {
  return {
    arm(at) {
      void storage.setAlarm(at).catch(() => undefined);
    },
    cancel() {
      void storage.deleteAlarm().catch(() => undefined);
    },
  };
}
const OWNER_KEY = "alarm-owner";

const failure = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export class WorkspaceHostStoreObject extends DurableObject<Env> {
  #owner: {
    store: AlarmStore;
    recovery?: SqlInterruptedTurnRecovery;
    retry?: SqlProviderTurnRetry;
    wake: () => void;
  } | null = null;
  /** Owner clock offset, so a seeded provider failure falls due shortly instead of after its real back-off. */
  #skew = 0;
  #alarms = 0;
  readonly #instance = crypto.randomUUID();
  get #database() {
    return durableObjectSqlDatabase(this.ctx.storage as unknown as DurableObjectStorage);
  }
  get #alarmStorage() {
    return this.ctx.storage as unknown as AlarmStorage;
  }
  /** Opens the dispatch owner over this object's SQL, as a fresh instance does when its alarm fires. */
  #open(store: AlarmStore) {
    if (this.#owner) return this.#owner;
    const database = this.#database;
    migrate(database, store);
    const lent = { database, close() {} };
    const now = () => Date.now() + this.#skew;
    let wake: () => void = () => {};
    const timer = (callback: () => void) => {
      wake = callback;
      return alarmWakeTimer(this.#alarmStorage);
    };
    const continued = (row: { attempts: number }, admit: () => boolean) =>
      Promise.resolve(admit() ? `auto-${row.attempts}` : null);
    const owner =
      store === "interrupted-turn-recovery"
        ? {
            store,
            recovery: new SqlInterruptedTurnRecovery(
              lent,
              {
                serialize: (_id, work) => work(),
                inspect: async (row) => (row.turnId.startsWith("auto-") ? "live" : "lost"),
                continue: (row, _current, admit) => continued(row, admit),
                changed: () => {},
              },
              300,
              () => true,
              now,
              timer,
            ),
          }
        : {
            store,
            retry: new SqlProviderTurnRetry(
              lent,
              {
                serialize: (_id, work) => work(),
                inspect: async (row) => (row.state === "running" ? "live" : { failure: row.failure }),
                continue: (row, _current, admit) => continued(row, admit),
                changed: () => {},
              },
              now,
              () => 0,
              () => true,
              timer,
            ),
          };
    return (this.#owner = { ...owner, wake: () => wake() });
  }
  override async alarm(): Promise<void> {
    this.#alarms++;
    const store = await this.#alarmStorage.get<AlarmStore>(OWNER_KEY);
    if (!store) return;
    const owner = this.#open(store);
    owner.wake();
    await (owner.recovery ?? owner.retry)!.recover();
  }
  async #alarmCall(method: Method, store: AlarmStore): Promise<unknown> {
    switch (method) {
      case "seed": {
        await this.#alarmStorage.put(OWNER_KEY, store);
        const owner = this.#open(store);
        if (owner.recovery) {
          owner.recovery.started("t", "original");
          owner.recovery.lost("t");
        } else {
          this.#skew = -4_700;
          owner.retry!.failed("t", "original", { kind: "overloaded" });
          this.#skew = 0;
        }
        return this.#observe(store);
      }
      case "engineWake": {
        const owner = this.#open(store);
        (owner.recovery ?? owner.retry)!.wake();
        return this.#observe(store);
      }
      case "observe":
        return this.#observe(store);
      default:
        this.ctx.abort("evicted for test");
        return null;
    }
  }
  async #observe(store: AlarmStore) {
    const owner = this.#open(store);
    return {
      snapshot: (owner.recovery ?? owner.retry)!.snapshot("t"),
      alarm: await this.#alarmStorage.getAlarm(),
      alarms: this.#alarms,
      instance: this.#instance,
    };
  }
  async call(method: Method, store: WorkspaceHostStore, limit?: number): Promise<unknown> {
    if (method === "seed" || method === "engineWake" || method === "observe" || method === "evict")
      return this.#alarmCall(method, store as AlarmStore);
    const database = this.#database;
    switch (method) {
      case "migrate":
        return migrate(database, store, limit);
      case "ledger":
        return ledger(database);
      case "schema":
        return schema(database);
      case "scenario":
        migrate(database, store);
        return scenario(database, store);
      case "tamperLedger":
        return Number(
          database.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run("0".repeat(64)).changes,
        );
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { object, method, store, limit } = (await request.json()) as {
      object: string;
      method: Method;
      store: WorkspaceHostStore;
      limit?: number;
    };
    try {
      const stub = env.STORE.get(env.STORE.idFromName(object));
      return Response.json({ ok: true, value: await stub.call(method, store, limit) });
    } catch (error) {
      return Response.json({ ok: false, error: failure(error) });
    }
  },
};
