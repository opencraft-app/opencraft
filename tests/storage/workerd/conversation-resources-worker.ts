// The conversation resource rows (InstallationCore, docs/architecture/platform/workspace-host-split.md
// §4.1) on Durable Object SQL: the Server core migrations run through the slim
// ledger runner and the unchanged runtime-neutral domain serves the same
// methods the Node owner Worker serves. There is no retired JSON journal in a
// DO, so no legacy port is passed. The unchanged ConversationResourceLifecycle
// also runs here with its cleanup retries on the owner wake-up port, merged with
// a second periodic owner onto the object's single alarm (gateway-split.md §4.2).
// Driven by tests/storage/conversation-resources-workerd.test.ts.
import { DurableObject } from "cloudflare:workers";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import {
  createServerMigrationComposition,
  DEFAULT_SERVER_MIGRATION_COMPOSITION,
} from "@opencraft/storage-node/server-composition";
import { migrateServerSqlDatabase } from "@opencraft/storage-node/server-sql";
import {
  conversationResourceMethods,
  type ConversationResourceMethods,
} from "@opencraft/storage-node/server-conversation-resources";
import type { SqlDatabase } from "@opencraft/sql";
import { mergedOwnerWake, periodicOwnerWork, type OwnerWake } from "@opencraft/owner-wake";
import { ConversationResourceLifecycle } from "../../../apps/headless-server/src/conversation-resource-lifecycle.mjs";

interface Env {
  /** Install only the first N published migrations, to exercise an upgrade across restarts. */
  readonly MIGRATION_LIMIT?: number;
  readonly CORE: { idFromName(name: string): unknown; get(id: unknown): ResourcesObject };
}
type LifecycleMethod = "lifecycleArchive" | "lifecycleHeal" | "lifecycleState" | "evict";
type Method = keyof ConversationResourceMethods | "ledger" | "sql" | "tamperLedger" | LifecycleMethod;
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Cleanup retry period of the lifecycle under test (5 s in the Node composition). */
const RETRY_MS = 200;
/** A second periodic owner on the same alarm, as resource reconciliation runs beside the retries. */
const RECONCILE_MS = 60_000;
const FAILING_KEY = "browser-owner-failing";
interface AlarmStorage {
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export class ResourcesObject extends DurableObject<Env> {
  #database: SqlDatabase | undefined;
  #methods: ConversationResourceMethods | undefined;
  #failure: unknown;
  #lifecycle: Promise<ConversationResourceLifecycle> | null = null;
  #alarm: (() => void) | null = null;
  #alarms = 0;
  #attempts = 0;
  readonly #instance = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      try {
        const composition = env.MIGRATION_LIMIT
          ? createServerMigrationComposition({
              canonical: DEFAULT_SERVER_MIGRATION_COMPOSITION.canonical.slice(0, env.MIGRATION_LIMIT),
              alternates: [],
              productVersion: "conversation-resources-test",
            })
          : undefined;
        const handle = migrateServerSqlDatabase(
          durableObjectSqlDatabase(ctx.storage as unknown as DurableObjectStorage),
          {
            ...(composition ? { composition } : {}),
            ownedByRuntime: (name) => name.startsWith("_cf_"),
          },
        );
        this.#database = handle.database;
        this.#methods = conversationResourceMethods(handle.database);
      } catch (error) {
        this.#failure = error;
      }
    });
  }

  get #storage() {
    return this.ctx.storage as unknown as AlarmStorage;
  }
  /** The object's single alarm as the owner wake-up port; `at` is the wall clock, as an alarm time is. */
  get #alarmWake(): OwnerWake {
    return {
      now: () => Date.now(),
      timer: (wake) => {
        this.#alarm = wake;
        return {
          arm: (at) => void this.#storage.setAlarm(at).catch(() => undefined),
          cancel: () => void this.#storage.deleteAlarm().catch(() => undefined),
        };
      },
    };
  }
  /** Opens the lifecycle beside a second periodic owner on one merged alarm and runs the opening pass the Node
   * composition runs at startup, so an instance that lost its memory resumes from the committed rows. */
  #openLifecycle(): Promise<ConversationResourceLifecycle> {
    return (this.#lifecycle ??= (async () => {
      const methods = this.#methods;
      if (!methods) throw new Error(`Server core unavailable: ${failure(this.#failure)}`);
      const wake = mergedOwnerWake(this.#alarmWake);
      const lifecycle = await ConversationResourceLifecycle.open(
        {
          call: {
            openConversationResources: async (input: { owners: readonly string[] }) =>
              methods.openConversationResources(input),
            putConversationResources: async (rows: Parameters<ConversationResourceMethods["putConversationResources"]>[0]) =>
              methods.putConversationResources(rows),
          },
        },
        {
          browser: async () => {
            this.#attempts++;
            if (await this.#storage.get<boolean>(FAILING_KEY)) throw new Error("browser owner unavailable");
          },
        },
        { wake, retryMs: RETRY_MS },
      );
      periodicOwnerWork(wake, RECONCILE_MS, () => {});
      lifecycle.retry();
      return lifecycle;
    })());
  }
  override async alarm(): Promise<void> {
    this.#alarms++;
    const lifecycle = await this.#openLifecycle();
    this.#alarm?.();
    // The alarm invocation lasts until the passes it started settle.
    await Promise.allSettled([...lifecycle.flights.values()]);
  }
  async #lifecycleCall(method: LifecycleMethod): Promise<unknown> {
    switch (method) {
      case "lifecycleArchive":
        await this.#storage.put(FAILING_KEY, true);
        await (await this.#openLifecycle()).observe("h", "archived-thread", "archived");
        return this.#lifecycleState();
      case "lifecycleHeal":
        await this.#storage.put(FAILING_KEY, false);
        return this.#lifecycleState();
      case "lifecycleState":
        return this.#lifecycleState();
      case "evict":
        this.ctx.abort("evicted for test");
        return null;
    }
  }
  async #lifecycleState() {
    return {
      rows: this.#methods!.openConversationResources({ owners: ["browser"] }),
      alarm: await this.#storage.getAlarm(),
      now: Date.now(),
      alarms: this.#alarms,
      attempts: this.#attempts,
      instance: this.#instance,
    };
  }

  call(method: Method, args: unknown[]): unknown {
    if (method === "lifecycleArchive" || method === "lifecycleHeal" || method === "lifecycleState" || method === "evict")
      return this.#lifecycleCall(method);
    const database = this.#database;
    if (!database) throw new Error(`Server core unavailable: ${failure(this.#failure)}`);
    if (method === "ledger")
      return database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
    // Test probe: one statement with positional parameters.
    if (method === "sql") {
      const [text, ...params] = args as [string, ...(string | number | null)[]];
      const statement = database.prepare(text);
      return /^\s*SELECT/i.test(text) ? statement.all(...params) : Number(statement.run(...params).changes);
    }
    if (method === "tamperLedger")
      return Number(
        database
          .prepare("UPDATE schema_migrations SET checksum=? WHERE version=?")
          .run("0".repeat(64), args[0] as number).changes,
      );
    if (!this.#methods) throw new Error("Conversation resources are only available on the current contract");
    return (this.#methods[method] as (...values: unknown[]) => unknown)(...args);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { object, method, args } = (await request.json()) as { object: string; method: Method; args: unknown[] };
    try {
      return Response.json({ ok: true, value: await env.CORE.get(env.CORE.idFromName(object)).call(method, args) });
    } catch (error) {
      return Response.json({ ok: false, error: failure(error) });
    }
  },
};
