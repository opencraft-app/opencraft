/**
 * Read-only view of the published Server migration chain for ledger tooling.
 * Consumers must not reach into the generated file by path; this entry is the
 * stable surface and keeps the product version out of the contract.
 */
export {
  SERVER_ALTERNATE_MIGRATIONS,
  SERVER_MIGRATION_CONTRACT_HASH,
  SERVER_MIGRATIONS,
} from "./migrations.generated.js";
