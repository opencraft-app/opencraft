// InstallationCore Durable Object prototype in workerd (Miniflare, no
// Cloudflare account). The scenarios are shared with the real-Cloudflare
// rehearsal (`npm run cf:rehearsal`); see
// tests/storage/workerd/installation-core.scenarios.ts and
// docs/architecture/platform/cloudflare-deployment.md ("InstallationCore prototype status").
//
// The installation's root input ports (gateway-split §4.1.1) must also bundle
// for a runtime without a file system: the port contracts reach no node:*
// module at all, and the document adapters reach no Node-only owner (files,
// Workers, node:sqlite); only the Hub and identity domains' node:crypto, which
// nodejs_compat provides.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { INSTALLATION_CORE_SCENARIOS } from "./workerd/installation-core.scenarios.ts";

const root = resolve(import.meta.dirname, "../..");
const NEUTRAL_PORTS = [
  "packages/access-control/src/commit-fence.ts",
  "packages/access-control/src/human-auth-configuration.ts",
  "packages/hub-network/src/state-port.ts",
  "apps/local-agent-host/src/machine-identity-document.ts",
];
const DOCUMENT_ADAPTERS = [
  "apps/headless-server/src/assembly/root-inputs.ts",
  "packages/hub-network/src/state-port-document.ts",
  "packages/access-control/src/identity-writes.ts",
];
const NODE_ONLY = [
  "packages/sqlite-node/",
  "packages/worker-owner/",
  "packages/identity-core/src/node.ts",
  "packages/hub-network/src/node.ts",
  "packages/hub-network/src/state-port-node.ts",
  "packages/hub-network/src/store-file.ts",
  "packages/access-control/src/commit-fence-shared-memory.ts",
  "apps/local-agent-host/src/machine-identity.ts",
];

async function inputs(entry: string, external: string[]) {
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
    external,
    logLevel: "silent",
  });
  return Object.entries(result.metafile.inputs).flatMap(([input, info]) => [
    input,
    ...info.imports.filter((imported) => imported.external).map((imported) => imported.path),
  ]);
}

for (const entry of NEUTRAL_PORTS)
  test(`${entry} bundles without any node:* module`, async () => {
    const reached = await inputs(entry, []);
    assert.deepEqual(
      reached.filter((input) => input.startsWith("node:") || NODE_ONLY.some((owner) => input.includes(owner))),
      [],
    );
  });

for (const entry of DOCUMENT_ADAPTERS)
  test(`${entry} reaches no Node-only owner, only node:crypto`, async () => {
    const reached = await inputs(entry, ["node:*"]);
    assert.deepEqual(reached.filter((input) => NODE_ONLY.some((owner) => input.includes(owner))), []);
    assert.deepEqual(
      [...new Set(reached.filter((input) => input.startsWith("node:")))].sort(),
      entry.includes("identity-writes") ? ["node:crypto"] : ["node:crypto", "node:util"],
    );
  });

testScenariosOnMiniflare("installation-core-workerd", INSTALLATION_CORE_SCENARIOS);
