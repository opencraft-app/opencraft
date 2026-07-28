import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCatalog } from "./catalog.mjs";

async function fixtureDirectory(t, scenarioPreset = "identity-mismatch") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mock-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "capabilities"), { recursive: true });
  await fs.mkdir(path.join(root, "scenarios"), { recursive: true });
  await fs.writeFile(
    path.join(root, "capabilities", "tencentcloud.yaml"),
    `capabilities:
  - id: tencentcloud.faceid.id-card-verification
    provider: fake-tencentcloud
    defaultPreset: success
    presets: [success, identity-mismatch]
`,
  );
  await fs.writeFile(
    path.join(root, "scenarios", "full.yaml"),
    "id: full\nname: Full\ntags: [default]\noverrides: {}\n",
  );
  await fs.writeFile(
    path.join(root, "scenarios", "failed.yaml"),
    `id: realname-failed
name: Failed
tags: [realname]
overrides:
  tencentcloud.faceid.id-card-verification:
    preset: ${scenarioPreset}
`,
  );
  return root;
}

test("catalog loads capabilities and sparse scenarios from YAML files", async (t) => {
  const root = await fixtureDirectory(t);

  const catalog = await loadCatalog(root);

  assert.equal(catalog.capabilities.size, 1);
  assert.equal(catalog.scenarios.size, 2);
  assert.equal(
    catalog.scenarios
      .get("realname-failed")
      .overrides["tencentcloud.faceid.id-card-verification"].preset,
    "identity-mismatch",
  );
});

test("catalog rejects a scenario that references an unknown preset", async (t) => {
  const root = await fixtureDirectory(t, "invented-result");

  await assert.rejects(
    loadCatalog(root),
    /unknown preset invented-result/,
  );
});
