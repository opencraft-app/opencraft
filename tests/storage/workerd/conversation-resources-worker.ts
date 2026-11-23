// The conversation resource rows (InstallationCore, docs/architecture/platform/workspace-host-split.md
// §4.1) on Durable Object SQL: the Server core migrations run through the slim
// ledger runner and the unchanged runtime-neutral domain serves the same
// methods the Node owner Worker serves. There is no retired JSON journal in a
// DO, so no legacy port is passed. Driven by tests/storage/conversation-resources-workerd.test.ts.
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

interface Env {
  /** Install only the first N published migrations, to exercise an upgrade across restarts. */
  readonly MIGRATION_LIMIT?: number;
  readonly CORE: { idFromName(name: string): unknown; get(id: unknown): ResourcesObject };
}
type Method = keyof ConversationResourceMethods | "ledger" | "sql" | "tamperLedger";
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class ResourcesObject extends DurableObject<Env> {
  #database: SqlDatabase | undefined;
  #methods: ConversationResourceMethods | undefined;
  #failure: unknown;

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

  call(method: Method, args: unknown[]): unknown {
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
