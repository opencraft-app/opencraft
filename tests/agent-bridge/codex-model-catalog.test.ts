import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { nativeCreateDiagnostic } from "../../apps/agent-bridge-host/src/codex-create-diagnostic.js";
import { codexModelMetadata } from "../../packages/account-pool-host/src/codex-model-catalog.js";

// Like the other stock-native tests, this uses an explicitly supplied binary,
// an empty home and a loopback-only synthetic provider, with no real account.
for (const catalog of ["empty", "429", "normal"] as const) {
  test(
    `stock native thread/start with ${catalog} model catalog`,
    {
      skip: !process.env.OPENCRAFT_TEST_NATIVE_CLI,
      timeout: 30_000,
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "oc-catalog-"));
      let catalogReads = 0,
        modelPosts = 0;
      const server = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url?.startsWith("/models")) {
          catalogReads++;
          res.statusCode = catalog === "429" ? 429 : 200;
          res.end(
            JSON.stringify(
              catalog === "429"
                ? { error: "private-quota-detail" }
                : {
                    models:
                      catalog === "normal"
                        ? [
                            codexModelMetadata(
                              "fixture-model",
                              { name: "Fixture", protocol: "openai-responses" },
                              { id: "fixture-model" },
                            ),
                          ]
                        : [],
                  },
            ),
          );
        } else {
          modelPosts++;
          res.statusCode = 500;
          res.end("{}");
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
      const child = spawn(
        process.env.OPENCRAFT_TEST_NATIVE_CLI!,
        [
          "app-server",
          "-c",
          'model_provider="fixture"',
          "-c",
          'model_providers.fixture.name="Fixture"',
          "-c",
          "features.api_key_model_discovery=true",
          "-c",
          'model_providers.fixture.env_key="FIXTURE_API_KEY"',
          "-c",
          `model_providers.fixture.base_url=${JSON.stringify(base)}`,
          "-c",
          `model_providers.fixture.model_catalog_url=${JSON.stringify(base + "/models")}`,
          "-c",
          'model_providers.fixture.wire_api="responses"',
          "-c",
          "model_providers.fixture.requires_openai_auth=false",
          "-c",
          'web_search="disabled"',
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, FIXTURE_API_KEY: "synthetic" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const exited = once(child, "exit");
      const lines = createInterface({ input: child.stdout });
      const pending = new Map<number, (frame: any) => void>();
      let sequence = 0;
      lines.on("line", (line) => {
        const frame = JSON.parse(line);
        if (typeof frame.id === "number") {
          pending.get(frame.id)?.(frame);
          pending.delete(frame.id);
        }
      });
      child.stderr.resume();
      t.after(async () => {
        child.kill();
        await exited;
        lines.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      });
      const rpc = (method: string, params: object) =>
        new Promise<any>((resolve) => {
          const id = ++sequence;
          pending.set(id, resolve);
          child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        });
      assert.ok(
        (
          await rpc("initialize", {
            clientInfo: { name: "catalog-fixture", version: "1" },
            capabilities: { experimentalApi: true },
          })
        ).result,
      );
      child.stdin.write('{"method":"initialized"}\n');
      const response = await rpc("thread/start", { cwd: root, ephemeral: false });
      assert.ok(catalogReads > 0, JSON.stringify(response));
      if (catalog === "normal") {
        assert.equal(response.result.thread.model, "fixture-model");
        assert.equal(typeof response.result.thread.id, "string");
      } else {
        assert.deepEqual(nativeCreateDiagnostic(response.error.code, response.error.message), {
          code: -32600,
          reason: "model-catalog-unavailable",
          notAllocated: true,
        });
        const listed = await rpc("thread/list", { limit: 10 });
        assert.deepEqual(listed.result.data, [], "no persistent session survives the rejected startup");
      }
      assert.equal(modelPosts, 0, "startup never submits a first turn or generation");
    },
  );
}
