import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOwnerMigrations } from "../../scripts/storage/storage-owner-source.mjs";

function dependency(modules: string, name: string, value: string) {
  mkdirSync(join(modules, name), { recursive: true });
  writeFileSync(join(modules, name, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.js" }));
  writeFileSync(join(modules, name, "index.js"), `export const value = ${JSON.stringify(value)};\n`);
}

test("a nested project resolves its own and its workspace dependencies when its owner is evaluated", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "owner-source-workspace-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const project = join(workspace, "products", "example");
  dependency(join(workspace, "node_modules"), "fixture-workspace-dep", "workspace");
  dependency(join(project, "node_modules"), "fixture-project-dep", "project");
  mkdirSync(join(project, "store"), { recursive: true });
  writeFileSync(
    join(project, "store", "owner.ts"),
    [
      "import { value as workspace } from 'fixture-workspace-dep';",
      "import { value as project } from 'fixture-project-dep';",
      'export const options = { schemaId: "fixture-nested", migrations: [{ version: 1, name: workspace + "_" + project, sql: "SELECT 1" }] };',
    ].join("\n"),
  );
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith("opencraft-schema-owner-")).length;
  const migrations = await readOwnerMigrations(project, { id: "fixture-nested", owner: "store/owner.ts" });
  assert.deepEqual(migrations, [{ version: 1, name: "workspace_project", sql: "SELECT 1" }]);
  assert.equal(
    readdirSync(tmpdir()).filter((name) => name.startsWith("opencraft-schema-owner-")).length,
    before,
    "the scratch module and its dependency links are removed",
  );
});
