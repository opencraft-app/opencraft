import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { profileFor, root } from "./helpers.mjs";
import { inspectLocalConfiguration } from "../src/runtime/local-diagnostics.mjs";

test("CLI doctor reports fixture honestly without starting a runner or model request", (t) => {
  const p = profileFor(t);
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      ["bin/assistant.mjs", "doctor", "--profile", p.path],
      { cwd: root, encoding: "utf8" },
    ),
  );
  assert.equal(output.mode, "fixture");
  assert.equal(output.actualModelRequestPerformed, false);
  assert.equal(output.productQualityVerified, false);
  assert.equal(output.credential, null);
  assert.equal(readdirSync(p.path).includes("assistant.sqlite"), false);
});

test("real-mode diagnostic exposes only credential presence and rejects unknown provider/model offline", async (t) => {
  const p = profileFor(t);
  p.config.mode = "model";
  p.config.model = { provider: "deepseek", modelId: "deepseek-flash" };
  const evidence = await inspectLocalConfiguration(p, {
    DEEPSEEK_API_KEY: "never-print-this-secret",
  });
  assert.equal(evidence.credential.present, true);
  assert.equal(evidence.actualModelRequestPerformed, false);
  assert.equal(
    JSON.stringify(evidence).includes("never-print-this-secret"),
    false,
  );
  p.config.model.modelId = "definitely-unknown-id";
  await assert.rejects(inspectLocalConfiguration(p, {}), /not present/);
});

test("real acceptance refuses fixture before creating a profile or starting model calls", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/accept-personal-assistant.mjs", "--mode", "fixture"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refuses fixture/);
  assert.equal(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).private,
    true,
  );
});
