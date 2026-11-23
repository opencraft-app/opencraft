// Synthetic compositions for tests/storage/server-extension-families.test.ts.
// The "private" lineage has the same shape as a downstream product that kept
// its own linear Server ledger: core steps reordered and renamed, two product
// steps inserted after core v14, one step merging two core steps, then the
// remaining core steps. Each step is renamed to its position, so the first two
// keep their core names, as in such a lineage. All names here are fixtures.
import type { Migration } from "@opencraft/sqlite-node";
import {
  createServerMigrationComposition,
  DEFAULT_SERVER_MIGRATION_COMPOSITION as base,
  type ServerLedgerIdentity,
  type ServerMigrationFamily,
} from "../../../packages/storage-node/src/server/migration-composition.js";

export const FAMILY_ID = "fixture-sync";
const familyMigrations: Migration[] = [
  {
    version: 1,
    name: "0000_fixture_requests",
    sql: "CREATE TABLE `fixture_sync_requests` (\n\t`message_id` text PRIMARY KEY NOT NULL,\n\t`channel_id` text NOT NULL,\n\t`reason` text\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `fixture_sync_request_channel` ON `fixture_sync_requests` (`channel_id`);",
  },
  {
    version: 2,
    name: "0001_fixture_group_sync",
    sql: "CREATE TABLE `fixture_sync_groups` (\n\t`source` text PRIMARY KEY NOT NULL,\n\t`channel_id` text NOT NULL,\n\t`value` text NOT NULL\n) STRICT;",
  },
];
export const family = (count = familyMigrations.length): ServerMigrationFamily => ({
  id: FAMILY_ID,
  objectPrefix: "fixture_sync_",
  migrations: familyMigrations.slice(0, count),
});

const core = (version: number) => base.canonical[version - 1]!;
const step = (name: string, sql: string, adopts: ServerLedgerIdentity[]) => ({ name, sql, adopts });
const coreStep = (version: number) =>
  step(core(version).name.replace(/^\d+_/, ""), core(version).sql, [{ family: "core", version }]);
const familyStep = (version: number) =>
  step(familyMigrations[version - 1]!.name.replace(/^\d+_/, ""), familyMigrations[version - 1]!.sql, [
    { family: FAMILY_ID, version },
  ]);
const steps = [
  ...[1, 2, 6, 7, 8, 9, 10, 11, 3, 4, 12, 13, 14].map(coreStep),
  familyStep(1),
  familyStep(2),
  ...[15, 16, 17, 18, 19, 5, 20].map(coreStep),
  // A reviewed step that applied two core steps at once: different bytes, same structure.
  step("merged_core_21_22", `${core(21).sql};\n${core(22).sql}`, [
    { family: "core", version: 21 },
    { family: "core", version: 22 },
  ]),
  ...[23, 24, 25].map(coreStep),
].map((entry, index) => ({ ...entry, name: `${String(index).padStart(4, "0")}_${entry.name}` }));

export const PRIVATE_LINEAGE_ID = "fixture-private-linear";
export const privateLineage = {
  id: PRIVATE_LINEAGE_ID,
  migrations: steps.map((entry, index): Migration => ({ version: index + 1, name: entry.name, sql: entry.sql })),
  adopts: steps.map((entry) => entry.adopts),
};

export const LATER_CORE: Migration = {
  version: base.canonical.length + 1,
  name: `${String(base.canonical.length).padStart(4, "0")}_fixture_later_core`,
  sql: "CREATE TABLE `fixture_later_core` (\n\t`id` text PRIMARY KEY NOT NULL\n) STRICT;",
};

export type CompositionName = "core" | "extension-v1" | "extension" | "extension-later-core" | "touches-core";
export function composition(name: CompositionName) {
  const productVersion = base.contract.productVersion;
  if (name === "core") return base;
  const canonical = name === "extension-later-core" ? [...base.canonical, LATER_CORE] : base.canonical;
  const extension =
    name === "touches-core"
      ? {
          ...family(1),
          migrations: [
            ...family(1).migrations,
            { version: 2, name: "0001_fixture_bad", sql: "ALTER TABLE `actors` ADD `fixture_sync_flag` integer;" },
          ],
        }
      : family(name === "extension-v1" ? 1 : 2);
  return createServerMigrationComposition({
    canonical,
    alternates: [
      ...base.alternates,
      ...(name === "extension" || name === "extension-later-core" ? [privateLineage] : []),
    ],
    extensions: [extension],
    productVersion,
  });
}
