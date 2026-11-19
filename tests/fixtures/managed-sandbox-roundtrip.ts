import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";
import { createPersonalAssistantHost } from "../../apps/personal-assistant/src/runtime/host-supervisor.mjs";
import { createSandboxAssistantProvider } from "../../apps/personal-assistant/src/runtime/sandbox-environment-provider.mjs";
const prefix = "opencraft/personal-assistant/";
const binary =
  "/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
const wait = async (check: () => Promise<boolean> | boolean, timeout = 35000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Managed sandbox round-trip timed out");
};
/** Real native Host/brain/ledger/DM fixture. Only the model provider is a controlled loopback stream.
 * Caller supplies either a deterministic provider or an explicitly authorized real E2B adapter. */
export async function managedSandboxRoundtrip({
  templateId = "approved",
  workspaceRoot,
  createBackend,
  delaySeconds = 0,
  expectUnknown = false,
}: any) {
  const directory = await mkdtemp(join(tmpdir(), "managed-sandbox-roundtrip-")),
    storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  const human = actors.resolveHuman({
    provider: "local",
    subject: "owner",
    displayName: "Owner",
    expiresAt: Date.now() + 120000,
  })!;
  const errors: unknown[] = [],
    proof = "isolated-environment-proof",
    resources = { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 };
  let completedTool = false,
    toolRequests = 0,
    modelCalls = 0,
    host: any,
    provider: any;
  const observations: any[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer synthetic-model-only");
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      modelCalls++;
      const schema = body.text?.format?.schema,
        tools = body.tools?.map((t: any) => t.name) ?? [];
      observations.push({
        schema: Object.keys(schema?.properties ?? {}),
        tools,
      });
      let item: any;
      if (tools.includes("environment_run")) {
        const outputs = body.input.filter(
          (v: any) => v.type === "function_call_output" && v.call_id === "run-isolated-once",
        );
        if (outputs.length) {
          assert.ok(JSON.stringify(outputs).includes(proof));
          assert.ok(JSON.stringify(outputs).includes("model-key=False"));
          completedTool = true;
          item = {
            type: "message",
            role: "assistant",
            id: "m" + modelCalls,
            phase: "final_answer",
            content: [
              {
                type: "output_text",
                text: proof + "; actual tool execution verified.",
              },
            ],
          };
        } else {
          toolRequests++;
          item = {
            type: "function_call",
            name: "environment_run",
            call_id: "run-isolated-once",
            arguments: JSON.stringify({
              argv: [
                "/usr/bin/python3",
                "-c",
                "import os,time;time.sleep(" +
                  delaySeconds +
                  ');print("' +
                  proof +
                  '");print("model-key="+str("SUPERAPP_CODEX_API_KEY" in os.environ))',
              ],
              timeoutMs: 30000,
            }),
          };
        }
      } else {
        const blocked = expectUnknown && toolRequests > 0;
        const value = schema?.properties?.operations
          ? {
              operations: [blocked ? "blocked" : completedTool ? "deliver" : "delegate"],
            }
          : {
              proposal: blocked
                ? {
                    kind: "blocked",
                    text: "Effect status is unknown; owner reconciliation required.",
                  }
                : completedTool
                  ? { kind: "deliver" }
                  : {
                      kind: "delegate",
                      goal: "Verify the explicitly configured isolated environment and report actual tool output.",
                      completion: {
                        output: "text",
                        requirements: [],
                        checks: [],
                      },
                    },
            };
        item = {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          id: "m" + modelCalls,
          content: [{ type: "output_text", text: JSON.stringify(value) }],
        };
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          { type: "response.created", response: { id: "r" + modelCalls } },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: {
              id: "r" + modelCalls,
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]
          .map((e) => "data: " + JSON.stringify(e) + "\n\n")
          .join(""),
      );
    } catch (error) {
      errors.push(error);
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    provider = await createSandboxAssistantProvider({
      backendId: "e2b",
      templates: [
        {
          id: templateId,
          name: "Isolated verification",
          resources,
          workspaceRoot,
        },
      ],
      capacity: resources,
      createBackend,
    });
    host = await (createPersonalAssistantHost as any)({
      directory,
      service,
      intervalMs: 30,
      codexBinary: binary,
      readConfig: async () => null,
      environmentProviders: { e2b: provider },
      modelSource: {
        catalog: async () => ({ available: true, models: [] }),
        resolve: async () => ({
          baseUrl: "http://127.0.0.1:" + (server.address() as any).port + "/v1",
          apiKey: "synthetic-model-only",
        }),
        close: async () => {},
      },
    });
    const created = await service.personalAssistant(human, prefix + "bots/create", {
        name: "Environment verifier",
        duties: "Verify only authorized isolated execution.",
        environment: { kind: "sandbox", backendId: "e2b", templateId },
        clientRequestId: "create-isolated-bot",
      }),
      bot = created.assistant;
    await service.personalAssistant(human, prefix + "model/set", {
      botId: bot.binding.botId,
      model: { providerId: "fixture", modelId: "controlled-model" },
      expectedRevision: 0,
    });
    await wait(
      async () =>
        (
          await service.personalAssistant(human, prefix + "get", {
            botId: bot.binding.botId,
          })
        ).runtime.phase === "running",
    );
    await service.send(human, {
      targetActorId: bot.actorId,
      content: "Please verify command execution in your configured isolated environment.",
      idempotencyKey: "sandbox-intake",
    });
    if (expectUnknown) {
      await wait(() => toolRequests === 1);
      await new Promise((r) => setTimeout(r, 2500));
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(directory, "bots", bot.binding.botId, "assistant.sqlite"), { readOnly: true });
      try {
        const rows = db.prepare("SELECT state FROM execution_native_receipt WHERE tool='environment_run'").all();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].state, "pending");
      } finally {
        db.close();
      }
      assert.equal(toolRequests, 1);
      assert.equal(completedTool, false);
    } else {
      await wait(async () => {
        const rows = await service.messages(human, bot.actorId, 0, 100);
        return completedTool && rows.some((m: any) => m.author_id === bot.actorId && m.content.includes(proof));
      });
      assert.equal(toolRequests, 1);
      assert.equal(completedTool, true);
    }
    assert.deepEqual(errors, []);
    const stored = await readFile(join(directory, "bots", bot.binding.botId, "profile.json"), "utf8");
    assert.ok(!stored.includes("synthetic-model-only"));
    assert.ok(!stored.includes("execution.environment"));
    await service.personalAssistant(human, prefix + "bots/pause", {
      botId: bot.binding.botId,
      paused: true,
      expectedRevision: 0,
    });
    await host.close();
    host = null;
    return {
      passed: true,
      modelCalls,
      toolRequests,
      botRoundtrip: !expectUnknown,
      unknownEffectFenced: expectUnknown,
      pauseCleanup: true,
      secretProjectionClean: true,
    };
  } catch (error) {
    // Only bounded schema/tool names are retained for debugging, never messages or credentials.
    if (errors.length) throw errors[0];
    throw Object.assign(error instanceof Error ? error : Error("Round-trip failed"), {
      observations: observations.slice(-12),
    });
  } finally {
    await host?.close();
    await provider?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await service.close();
    actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
}
