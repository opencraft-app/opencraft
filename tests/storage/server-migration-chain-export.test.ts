import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as chain from "@opencraft/storage-node/server/migrations";
import * as generated from "../../packages/storage-node/src/server/migrations.generated";

test("the server migration chain subpath resolves to the curated module", () => {
  const resolved = createRequire(import.meta.url).resolve("@opencraft/storage-node/server/migrations");
  assert.match(resolved, /packages[\\/]storage-node[\\/]src[\\/]server[\\/]migration-chain\.ts$/);
});

test("ledger tooling reads the published chain without importing generated files by path", () => {
  assert.deepEqual(Object.keys(chain).sort(), [
    "SERVER_ALTERNATE_MIGRATIONS",
    "SERVER_MIGRATIONS",
    "SERVER_MIGRATION_CONTRACT_HASH",
  ]);
  assert.equal(chain.SERVER_MIGRATIONS, generated.SERVER_MIGRATIONS);
  assert.equal(chain.SERVER_ALTERNATE_MIGRATIONS, generated.SERVER_ALTERNATE_MIGRATIONS);
  assert.match(chain.SERVER_MIGRATION_CONTRACT_HASH, /^[a-f0-9]{64}$/);
  assert.ok(chain.SERVER_MIGRATIONS.length > 0);
  assert.ok(chain.SERVER_ALTERNATE_MIGRATIONS.every((history) => history.migrations.length > 0));
});
