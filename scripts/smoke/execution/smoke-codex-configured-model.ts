import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  AccountPoolStore,
  CodexAccountPoolProxy,
  startCodexAccountPoolServer,
  createCodexAccountPoolLaunch,
} from "../../../packages/account-pool-host/src/index.js";
import {
  ModelConfigurationRepository,
  ModelCredentialRepository,
} from "../../../apps/local-agent-host/src/model-config/repository.js";
import {
  createConfiguredCodexResponses,
  configuredCodexModelId,
} from "../../../apps/codex-core/src/configured-responses.js";

const executable = process.env.OPENCRAFT_CODEX_EXECUTABLE;
const anthropic = process.argv.includes("--anthropic");
const refusal = process.argv.includes("--refusal");
const productionAuth = process.argv.includes("--production-auth");
const composedSchema = process.argv.includes("--composed-schema");
if (!executable) throw Error("Set OPENCRAFT_CODEX_EXECUTABLE");
const root = await mkdtemp(join(tmpdir(), "codex-configured-native-")),
  home = join(root, "home");
await mkdir(home);
const store = new AccountPoolStore({
  databasePath: join(root, "pool.sqlite"),
  secretsDirectory: join(root, "secrets"),
});
const repository = new ModelConfigurationRepository(join(root, "models"));
await repository.initialize({
  schemaVersion: 1,
  revision: 0,
  defaultModel: null,
  providers: [
    {
      id: "fixture",
      name: "Configured fixture",
      protocol: anthropic ? "anthropic-messages" : "openai-responses",
      baseUrl: "http://127.0.0.1/v1",
      credentialRef: anthropic ? "SMOKE_ANTHROPIC" : null,
      ...(anthropic ? {} : { authentication: "none" as const }),
      enabled: true,
      models: [{ id: "ep-test", enabled: true, input: ["text"] }],
    },
  ],
});
if (anthropic) await new ModelCredentialRepository(repository.directory).set("SMOKE_ANTHROPIC", "fixture");
const alias = configuredCodexModelId("fixture", "ep-test");
let inferenceCalls = 0;
let nativeToolCalls = 0;
const proxy = new CodexAccountPoolProxy({
  store,
  upstreamBaseUrl: "http://oauth.test/codex",
  configuredResponses: createConfiguredCodexResponses(repository.directory),
  fetch: (async (url, options) => {
    assert.equal(String(url), "http://127.0.0.1/v1/" + (anthropic ? "messages" : "responses"));
    assert.equal(JSON.parse(String(options?.body)).model, "ep-test");
    inferenceCalls++;
    if (anthropic) {
      const body = JSON.parse(String(options?.body));
      for (const tool of body.tools)
        for (const key of ["oneOf", "anyOf", "allOf"])
          assert.equal(Object.hasOwn(tool.input_schema, key), false, "Anthropic forbids root combinators");
      if (refusal) {
        const events = [
          { type: "message_start", message: { id: "msg-refusal", role: "assistant", content: [], usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              name: "fixture_echo",
              id: "refused-call",
              input: composedSchema ? { arguments: { value: "must-not-run" } } : { value: "must-not-run" },
            },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "refusal" }, usage: {} },
          { type: "message_stop" },
        ];
        return new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const selected = body.tools.find((tool: any) => tool.name === "fixture_echo");
      assert(selected, "Native dynamic tool must survive the Messages conversion");
      const second = body.messages.some((message: any) =>
        message.content.some((part: any) => part.type === "tool_result" && part.tool_use_id === "fixture-call"),
      );
      if (second && composedSchema)
        assert.deepEqual(
          body.messages
            .flatMap((m: any) => m.content)
            .find((c: any) => c.type === "tool_use" && c.id === "fixture-call").input,
          { arguments: { value: "fixture" } },
        );
      const content = second
        ? { type: "text", text: "configured-ready" }
        : {
            type: "tool_use",
            name: selected.name,
            id: "fixture-call",
            input: composedSchema ? { arguments: { value: "fixture" } } : { value: "fixture" },
          };
      const events = [
        {
          type: "message_start",
          message: { id: "msg-fixture", role: "assistant", content: [], usage: { input_tokens: 1 } },
        },
        { type: "content_block_start", index: 0, content_block: content },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: second ? "end_turn" : "tool_use" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    const item = {
      id: "message-test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "configured-ready", annotations: [] }],
    };
    const events = [
      {
        type: "response.created",
        response: { id: "response-test", object: "response", status: "in_progress", output: [] },
      },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "response-test",
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch,
});
const server = await startCodexAccountPoolServer({ proxy });
const hostToken = store.issueHostToken("local-codex"),
  launch = createCodexAccountPoolLaunch({ baseUrl: server.url, hostToken });
const child = spawn(
  executable,
  productionAuth
    ? ["app-server", ...launch.args, "-c", `model=${JSON.stringify(alias)}`]
    : [
        "app-server",
        "-c",
        'model_provider="fixture"',
        "-c",
        `model=${JSON.stringify(alias)}`,
        "-c",
        'model_providers.fixture.name="Fixture"',
        "-c",
        `model_providers.fixture.base_url=${JSON.stringify(server.url + "/v1")}`,
        "-c",
        `model_providers.fixture.model_catalog_url=${JSON.stringify(server.url + "/v1/models")}`,
        "-c",
        'model_providers.fixture.env_key="SMOKE_API_KEY"',
        "-c",
        'model_providers.fixture.wire_api="responses"',
        "-c",
        "model_providers.fixture.requires_openai_auth=false",
        "-c",
        'model_providers.fixture.env_http_headers.x-opencraft-account-pool-token="SMOKE_HOST_TOKEN"',
        "-c",
        'web_search="disabled"',
      ],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: home,
      TMPDIR: root,
      SMOKE_API_KEY: "fixture",
      SMOKE_HOST_TOKEN: hostToken,
      ...(productionAuth ? launch.env : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
let sequence = 0,
  stderr = "",
  finish!: (value: any) => void;
const done = new Promise<any>((resolve) => {
  finish = resolve;
});
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-4000);
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "item/tool/call") {
    nativeToolCalls++;
    assert.equal(message.params.tool, "fixture_echo");
    if (composedSchema && !refusal) assert.deepEqual(message.params.arguments, { value: "fixture" });
    child.stdin.write(
      JSON.stringify({
        id: message.id,
        result: { success: true, contentItems: [{ type: "inputText", text: "fixture-result" }] },
      }) + "\n",
    );
    return;
  }
  if (message.method === "turn/completed") finish(message.params.turn);
  if (typeof message.id === "number" && pending.has(message.id)) {
    const request = pending.get(message.id)!;
    pending.delete(message.id);
    message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result);
  }
});
const rpc = (method: string, params: unknown) =>
  new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
const timeout = setTimeout(() => {
  for (const request of pending.values()) request.reject(Error("Native model fixture timeout: " + stderr));
  finish({ status: "timeout" });
  child.kill();
}, 30000);
try {
  await rpc("initialize", {
    clientInfo: { name: "configured-model-fixture", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized","params":{}}\n');
  if (productionAuth) await rpc("account/login/start", launch.auth);
  const catalog = await rpc("model/list", { includeHidden: false });
  assert.ok(
    catalog.data.some((entry: any) => entry.model === alias),
    "Configured model must appear in native model/list: " + JSON.stringify(catalog) + stderr,
  );
  const { thread } = await rpc("thread/start", {
    cwd: root,
    model: alias,
    approvalPolicy: "never",
    sandbox: "read-only",
    ...(anthropic
      ? {
          dynamicTools: [
            {
              name: "fixture_echo",
              description: "Echo",
              inputSchema: composedSchema
                ? {
                    oneOf: [
                      {
                        type: "object",
                        properties: { value: { type: "string" } },
                        required: ["value"],
                        additionalProperties: false,
                      },
                    ],
                  }
                : { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
            },
          ],
        }
      : {}),
  });
  await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Reply ready", text_elements: [] }] });
  const completed = await done;
  assert.equal(completed.status, refusal ? "failed" : "completed", JSON.stringify(completed.error) + stderr);
  assert.equal(inferenceCalls, anthropic && !refusal ? 2 : 1);
  assert.equal(store.affinityCount(), 0);
  assert.equal(nativeToolCalls, anthropic && !refusal ? 1 : 0, "Refused tool calls must not execute");
  console.log(
    JSON.stringify({
      passed: true,
      nativeCatalog: true,
      nativeTurn: true,
      productionAuth,
      composedSchema,
      nativeToolRoundTrip: anthropic && !refusal,
      refusalWithoutRetry: refusal,
      providerIsolation: true,
      model: alias,
    }),
  );
} finally {
  clearTimeout(timeout);
  lines.close();
  child.kill();
  if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await server.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
