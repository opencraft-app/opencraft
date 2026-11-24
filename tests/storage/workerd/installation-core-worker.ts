// InstallationCore Durable Object prototype (docs/architecture/platform/cloudflare-deployment.md §2).
// One SQLite-backed DO owns the Server core data: it migrates its own SQL
// database with the slim Server lifecycle and serves the unchanged
// access-control domain stores over RPC. Bundled with esbuild (`workerd`
// export condition, nodejs_compat) and driven through Miniflare by
// tests/storage/installation-core-workerd.test.ts. Test-only fixture for the
// migration and domain-port scenarios; the production object, which opens the
// installation module and serves its front door, is
// apps/headless-server/src/cloudflare/installation-core.ts.
import { DurableObject } from "cloudflare:workers";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import {
  createServerMigrationComposition,
  DEFAULT_SERVER_MIGRATION_COMPOSITION,
} from "@opencraft/storage-node/server-composition";
import { migrateServerSqlDatabase } from "@opencraft/storage-node/server-sql";
import { InstallationCoreDomain, type InstallationCoreMethod } from "./installation-core-domain.js";
import { durableObjectStateDocumentStore } from "@opencraft/storage-cloudflare/state";
import { InstallationRootInputsDomain, type InstallationRootInputsMethod } from "./installation-root-inputs-domain.js";

interface Env {
  /** Test only: install the first N published migrations, to exercise an upgrade across restarts. */
  readonly MIGRATION_LIMIT?: number;
  readonly CORE: {
    idFromName(name: string): unknown;
    get(id: unknown): InstallationCore & { fetch(request: Request): Promise<Response> };
  };
}

const failure = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export class InstallationCore extends DurableObject<Env> {
  #domain: InstallationCoreDomain | undefined;
  #inputs: InstallationRootInputsDomain | undefined;
  #failure: unknown;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Migrations finish before any request is delivered. A refused or failed
    // open keeps the object closed: every call fails, none reads stale state.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        const database = durableObjectSqlDatabase(ctx.storage as unknown as DurableObjectStorage);
        const composition = env.MIGRATION_LIMIT
          ? createServerMigrationComposition({
              canonical: DEFAULT_SERVER_MIGRATION_COMPOSITION.canonical.slice(0, env.MIGRATION_LIMIT),
              alternates: [],
              productVersion: "installation-core-test",
            })
          : undefined;
        const handle = migrateServerSqlDatabase(database, {
          ...(composition ? { composition } : {}),
          ownedByRuntime: (name) => name.startsWith("_cf_"),
        });
        this.#domain = new InstallationCoreDomain({ database: handle.database, outcome: handle.outcome });
        // Root inputs: the object's own state documents and the same SQL owner (gateway-split §4.1.1).
        this.#inputs = new InstallationRootInputsDomain(
          durableObjectStateDocumentStore(ctx.storage as unknown as DurableObjectStorage, { prefix: "installation/" }),
          { database: handle.database, outcome: handle.outcome },
        );
      } catch (error) {
        this.#failure = error;
      }
    });
  }

  #open(): InstallationCoreDomain {
    if (!this.#domain) throw new Error(`InstallationCore is unavailable: ${failure(this.#failure)}`);
    return this.#domain;
  }

  /** RPC: one domain method by name. Arguments and results are structured-clone data. */
  call(method: InstallationCoreMethod, args: unknown[]): unknown {
    const domain = this.#open();
    return (domain[method] as (...values: unknown[]) => unknown).apply(domain, args);
  }

  /** RPC: one root input port method by name (installation-root-inputs-domain.ts). */
  inputs(method: InstallationRootInputsMethod, args: unknown[]): unknown {
    this.#open();
    const inputs = this.#inputs!;
    return (inputs[method] as (...values: unknown[]) => unknown).apply(inputs, args);
  }

  /** Test probe: rewrite one ledger checksum in place, as tampering or a changed published migration would. */
  tamperLedger(version: number): number {
    const domain = this.#open();
    return Number(
      domain.handle.database
        .prepare("UPDATE schema_migrations SET checksum=? WHERE version=?")
        .run("0".repeat(64), version).changes,
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { object, method, args } = (await request.json()) as {
      object: string;
      method: InstallationCoreMethod | "tamperLedger" | `inputs.${InstallationRootInputsMethod}`;
      args: unknown[];
    };
    const stub = env.CORE.get(env.CORE.idFromName(object));
    try {
      const value =
        method === "tamperLedger"
          ? await stub.tamperLedger(args[0] as number)
          : method.startsWith("inputs.")
            ? await stub.inputs(method.slice("inputs.".length) as InstallationRootInputsMethod, args)
            : await stub.call(method as InstallationCoreMethod, args);
      return Response.json({ ok: true, value });
    } catch (error) {
      return Response.json({ ok: false, error: failure(error) });
    }
  },
};
