// WorkspaceHost-side stores on the runtime-neutral SQL port in workerd
// (Miniflare, no Cloudflare account); see
// tests/storage/workerd/workspace-stores.scenarios.ts and gateway-split.md §4.2
// (storage row). The domain modules must bundle for a runtime without node:*
// modules or Node globals: only their Node shells (thread-directory/node.ts with
// the snapshot reader Worker, employee-git-vault-store.node.ts with the file
// checks, KeyMaterial and node:crypto) import node:* or @opencraft/sqlite-node.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import {
  decodeGitVaultBase64Url,
  encodeGitVaultBase64Url,
} from "../../packages/execution-environment/src/employee-git-vault-store.ts";
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { WORKSPACE_STORE_SCENARIOS } from "./workerd/workspace-stores.scenarios.ts";

const root = resolve(import.meta.dirname, "../..");
const NEUTRAL_DOMAINS = [
  // ThreadDirectory domain (thread-directory/node.ts is its Node shell).
  "packages/app-host-server/src/thread-directory/index.ts",
  // EmployeeGitVault domain (employee-git-vault-store.node.ts is its Node owner).
  "packages/execution-environment/src/employee-git-vault-store.ts",
];

for (const entry of NEUTRAL_DOMAINS)
  test(`${entry} bundles without node:* modules, Buffer or the Node SQLite owner`, async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "import"],
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.deepEqual(
      inputs.filter(
        (input) =>
          input.startsWith("node:") ||
          input.includes("packages/sqlite-node/") ||
          input.endsWith("snapshot-reader.ts") ||
          input.endsWith(".node.ts") ||
          input.endsWith("/node.ts"),
      ),
      [],
    );
    // Comments are gone from the bundle; any remaining Buffer is a Node global dependency.
    assert.doesNotMatch(result.outputFiles[0]!.text, /\bBuffer\b/u);
  });

test("vault envelope base64url equals Buffer's on random input and rejects what Buffer would not round-trip", () => {
  for (let length = 0; length < 200; length++) {
    const bytes = new Uint8Array(randomBytes(length));
    const encoded = encodeGitVaultBase64Url(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString("base64url"));
    assert.deepEqual(decodeGitVaultBase64Url(encoded), new Uint8Array(Buffer.from(encoded, "base64url")));
  }
  for (const text of ["A", "AB", "ABC", "AB_-", "AAB", "AAAAA", "____", "Zg", "Zh", "Zm8", "Zm9"]) {
    const ours = encodeGitVaultBase64Url(decodeGitVaultBase64Url(text)) === text;
    const buffer = Buffer.from(Buffer.from(text, "base64url")).toString("base64url") === text;
    assert.equal(ours, buffer, text);
  }
});

testScenariosOnMiniflare("workspace-stores-workerd", WORKSPACE_STORE_SCENARIOS);
