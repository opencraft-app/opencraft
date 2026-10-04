import assert from "node:assert/strict";
import test from "node:test";
import { readSshServerCatalog } from "../apps/workbench-web/src/runtime/ssh-server-catalog.js";

test("SSH catalog is bounded same-origin public metadata, not credentials", async () => {
  const profiles = await readSshServerCatalog(async (input, options) => {
    assert.equal(input, "/__opencraft_ssh_servers");
    assert.equal(options?.credentials, "same-origin");
    assert.equal(options?.cache, "no-store");
    assert.ok(options?.signal);
    return Response.json([{ serverId: "ssh:test", displayName: "Remote", workspaceBrowseRoots: ["/remote"], authentication: "must-not-project" }]);
  });
  assert.deepEqual(profiles, [{ serverId: "ssh:test", displayName: "Remote", workspaceBrowseRoots: ["/remote"] }]);
});

test("missing, failed or invalid remote catalog cannot disable the local Server", async () => {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args) => { warnings.push(args); };
  try {
    assert.deepEqual(await readSshServerCatalog(async () => new Response(null, { status: 404 })), []);
    assert.equal(warnings.length, 0);
    for (const fetchCatalog of [
      async () => new Response("private failure", { status: 503 }),
      async () => { throw new Error("private failure"); },
      async () => Response.json([{ serverId: "local-codex", displayName: "Invalid", workspaceBrowseRoots: [] }]),
    ]) assert.deepEqual(await readSshServerCatalog(fetchCatalog), []);
    assert.equal(warnings.length, 3);
    assert.ok(warnings.every(args => JSON.stringify(args) === JSON.stringify(["[ssh-server-catalog] Remote connections unavailable"])));
  } finally { console.warn = original; }
});
