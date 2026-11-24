import { createMissingLegacyObjects } from "@opencraft/sqlite-node";
import { SERVER_LEGACY_MIGRATIONS, type ServerStoreId } from "./legacy.js";

/** `openManagedDatabase` options for one historical per-store Server file (Node openers only). */
export function serverLegacyOptions(store: ServerStoreId) {
  const migrations = SERVER_LEGACY_MIGRATIONS[store];
  return {
    migrations,
    legacyPolicy: store === "memberships" ? ("reject-unknown" as const) : ("reject" as const),
    ...(store === "memberships"
      ? { legacyMigration: createMissingLegacyObjects(migrations.map((m) => m.sql).join("\n")) }
      : {}),
  };
}
