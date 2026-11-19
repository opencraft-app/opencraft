import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";

const executable = process.env.OPENCRAFT_TEST_CODEX_EXECUTABLE;
test(
  "real native: published empty creation supports first-input settings and pagination",
  { skip: !executable, timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "native-empty-index-adapter-"));
    const home = join(root, "home"),
      cwd = join(root, "workspace"),
      codexHome = join(root, "codex");
    await Promise.all([home, cwd, codexHome].map((path) => mkdir(path)));
    await writeFile(
      join(codexHome, "config.toml"),
      'model="fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local test only"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n',
    );
    const frames: any[] = [];
    const adapter = new CodexEngineAdapter({
      executable: executable!,
      runtimeDirectory: cwd,
      dataDirectory: join(root, "host"),
      nativeCodexHomeDirectory: codexHome,
      upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
      fetch: async () => Response.json({ ok: true }),
      spawnAppServer: () =>
        spawn(executable!, ["-c", "thread_unload_delay_secs=0", "app-server", "--listen", "stdio://"], {
          cwd,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CODEX_HOME: codexHome,
            CODEX_DISABLE_ANALYTICS: "1",
            RUST_LOG: "error",
          },
          stdio: ["pipe", "pipe", "pipe"],
        }),
      sessionMcp: async () => ({ enabled: false, url: "http://127.0.0.1:9/mcp" }),
      createMaintenanceClient: async () => {
        throw Error("not used");
      },
      logDiagnostic: () => {},
    });
    adapter.subscribeMessage((frame) => frames.push(JSON.parse(frame)));
    const request = async (id: string, method: string, params: object) => {
      await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "local-test" }));
      for (let i = 0; i < 1500; i++) {
        const reply = frames.find((frame) => frame.id === id);
        if (reply) {
          assert.equal(reply.error, undefined, JSON.stringify(reply.error));
          return reply.result;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Error("Timed out: " + method);
    };
    try {
      await adapter.connect();
      await request("init", "initialize", {
        clientInfo: { name: "native-index-test", version: "1" },
        capabilities: { experimentalApi: true },
      });
      const created = await request("create", "thread/start", {
        cwd,
        model: "fixture",
        modelProvider: "fixture",
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const threadId = created.thread.id;
      // Exercise the physical capture-settings RPC; provisional replies must not mask failure.
      const live = await (adapter as any).requestPhysical("thread/resume", { threadId, excludeTurns: true });
      assert.equal(live.thread.id, threadId);
      assert.equal(live.cwd, cwd);
      assert.equal(live.model, "fixture");
      assert.equal(live.modelProvider, "fixture");
      assert.equal(live.thread.projectId, created.thread.projectId);
      assert.equal(live.approvalPolicy, "never");
      assert.equal(live.sandbox.type, "readOnly");
      const page = await (adapter as any).requestPhysical("thread/turns/list", {
        threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      assert.deepEqual(page.data, []);
      const indexed = execFileSync(
        "python3",
        [
          "-c",
          'import sqlite3,sys;d=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True);print(d.execute("select count(*) from threads where id=?",(sys.argv[2],)).fetchone()[0])',
          join(codexHome, "state_5.sqlite"),
          threadId,
        ],
        { encoding: "utf8" },
      );
      assert.equal(Number(indexed.trim()), 1);
      // Exercise real tool preparation with the deployed zero-delay native unload
      // policy. The model endpoint is loopback-only; acceptance is not completion.
      const accepted = await request("first-input", "turn/start", {
        threadId,
        clientUserMessageId: "local-first-input",
        input: [{ type: "text", text: "Local regression only. Do not call tools." }],
      });
      assert.ok(accepted.turn?.id, JSON.stringify(accepted));
      console.log(
        execFileSync(executable!, ["--version"], { encoding: "utf8" }).trim() +
          ": indexed empty creation; capture-settings RPC and genuine first turn/start succeed (loopback model only)",
      );
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
