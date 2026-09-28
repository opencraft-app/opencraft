import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { syncSharedPackages } from "../scripts/sync-shared-packages.mjs";

test("OpenCraft owns verifiable snapshots for shared workspace dependencies", async () => {
  await syncSharedPackages({ check: true });
  const collaboration = JSON.parse(await readFile(new URL("../plugins/lightvela-collaboration/package.json", import.meta.url), "utf8"));
  const hermes = JSON.parse(await readFile(new URL("../plugins/lightvela-hermes/package.json", import.meta.url), "utf8"));
  assert.equal(collaboration.dependencies["@lightvela/vela-chat-client-core"], "0.0.0");
  assert.equal(hermes.dependencies["@lightvela/agent-core"], "0.1.0");
});
