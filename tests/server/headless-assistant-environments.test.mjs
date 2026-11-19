import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeadlessServer } from "../../scripts/headless-application.mjs";

test("actual Headless HTTP catalogue registers private sandbox configuration and fails optional invalid configuration closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-environments-")),
    webRoot = join(root, "web"),
    configPath = join(root, "environments.json"),
    key = join(root, "key");
  let app;
  const prior = process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG;
  try {
    await mkdir(webRoot);
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Environment fixture</title>");
    await writeFile(
      join(webRoot, "version.json"),
      JSON.stringify({
        schemaVersion: 1,
        buildId: "environment-fixture",
        headlessServer: true,
        headlessHostId: "opencraft-server",
      }),
    );
    await writeFile(key, "synthetic-e2b-controller-key", { mode: 0o600 });
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        backend: "e2b",
        apiUrl: "https://sandbox.invalid",
        sandboxUrl: "https://sandbox.invalid",
        apiKeyFile: key,
        capacity: { cpuMillis: 8000, memoryBytes: 17179869184 },
        templates: [
          {
            id: "approved",
            name: "Approved template",
            resources: { cpuMillis: 8000, memoryBytes: 17179869184 },
            workspaceRoot: "/home/user/work",
          },
        ],
        lease: { timeoutMs: 30000, renewEveryMs: 5000, maxLifetimeMs: 60000 },
      }),
      { mode: 0o600 },
    );
    process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG = configPath;
    const principal = {
      provider: "fixture-directory",
      subject: "environment-owner",
      displayName: "Fixture",
      expiresAt: Date.now() + 120000,
    };
    const options = {
      root,
      webRoot,
      dataDirectory: join(root, "data"),
      port: 0,
      accessMemberProviders: [principal.provider],
      startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", async close() {} }),
    };
    const composition = {
      createIdentity: async () => ({
        providers: [{ authenticate: (r) => (r.headers["x-fixture-proof"] === "verified" ? principal : null) }],
        close() {},
      }),
    };
    for (const valid of [true, false]) {
      await chmod(configPath, valid ? 0o600 : 0o644);
      app = await startHeadlessServer(options, composition);
      const response = await fetch(app.url + "/__opencraft_actors/collaboration/personal-assistant/environments", {
        method: "POST",
        headers: { "x-fixture-proof": "verified", origin: app.url, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 200);
      const catalog = await response.json();
      assert.equal(catalog.local, true);
      assert.deepEqual(
        catalog.templates,
        valid ? [{ backendId: "e2b", id: "approved", name: "Approved template" }] : [],
      );
      assert.ok(!JSON.stringify(catalog).includes("synthetic-e2b-controller-key"));
      assert.ok(!JSON.stringify(catalog).includes("sandbox.invalid"));
      assert.equal((await fetch(app.url)).status, 401);
      await app.close();
      app = undefined;
    }
  } finally {
    await app?.close();
    if (prior === undefined) delete process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG;
    else process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG = prior;
    await rm(root, { recursive: true, force: true });
  }
});
