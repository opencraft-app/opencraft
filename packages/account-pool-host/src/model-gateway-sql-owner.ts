// The model gateway for an owner whose SQL database is exclusive, durable and
// shared with other chains (the AccountCore Durable Object; cloudflare-deployment
// §5.6, storage-ports §7). The gateway's published chain is migrated as the
// named chain `model-gateway` in `schema_ledgers`: the same SQL, names and
// checksums the Node owner applies to its own file (model-gateway-store.ts),
// checked against the generated store contract. Runtime-neutral apart from
// node:crypto (Node, and workerd under nodejs_compat) for the checksums. The
// Node owner keeps its file and its `openManagedDatabase` lifecycle.
import { createHash } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";
import { hashSqlMigrations, resolveSqlMigrationContract } from "@opencraft/sql/migrations";
import { migrateSqlSchema, type SqlSchemaDeclaration } from "@opencraft/sql/schema-ledgers";
import { STORE_MIGRATIONS } from "@opencraft/sqlite-node/store-migrations-data";
import {
  MODEL_GATEWAY_SCHEMA,
  modelGatewayMigrations,
  ownedByModelGateway,
  type ModelGatewayDatabase,
} from "./model-gateway.js";

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** The gateway's chain as a shared database hosts it; every object carries the `gateway_` prefix. */
export function modelGatewaySqlSchema(): SqlSchemaDeclaration {
  return {
    schema: MODEL_GATEWAY_SCHEMA,
    migrations: hashSqlMigrations(
      resolveSqlMigrationContract(modelGatewayMigrations, STORE_MIGRATIONS[MODEL_GATEWAY_SCHEMA], sha256Hex),
      sha256Hex,
    ),
    owns: ownedByModelGateway,
  };
}

/**
 * Migrates the gateway's chain in the shared database. A changed, newer or
 * foreign history refuses the open, as do gateway objects without the chain's
 * ledger. The returned `close` releases nothing: the database belongs to its owner.
 */
export function migrateModelGatewaySqlDatabase(database: SqlDatabase): ModelGatewayDatabase {
  const outcome = migrateSqlSchema(database, modelGatewaySqlSchema());
  return {
    database,
    outcome: { status: outcome.status, appliedVersion: outcome.appliedVersion, movedAsidePaths: [] },
    close() {},
  };
}
