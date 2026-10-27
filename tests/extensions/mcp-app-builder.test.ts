import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  McpAppsService,
  MCP_APPS_SERVER,
  MCP_APPS_METHOD,
} from "../../packages/mcp-apps/src/server";
import { McpAppsRpcSession } from "../../packages/mcp-apps/src/transport";
import { javascript } from "../../packages/mcp-apps/src/javascript";
import { validateSpec } from "../../packages/mcp-apps/src/spec";
import { appMigrations } from "../../packages/mcp-apps/src/store";
import { openManagedDatabase } from "../../packages/sqlite-node/src/index";
import { MCP_APP_RESOURCE_META } from "../../packages/appserver-protocol/src/mcp-apps";

export function sampleSpec() {
  return {
    appId: "calculator",
    title: "Calculator",
    description: "A working calculator",
    entryTool: "calculate",
    uiHtml:
      '<!doctype html><html><body><button id="go">Calculate</button><output id="value">Ready</output><script>document.getElementById("go").onclick=async()=>{const r=await window.openai.callTool("calculate",{a:7,b:8});document.getElementById("value").textContent=r.structuredContent.sum};</script></body></html>',
    tools: [
      {
        name: "calculate",
        title: "Calculate",
        description: "Add two numbers",
        readOnlyHint: true,
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { sum: { type: "number" } },
          required: ["sum"],
          additionalProperties: false,
        },
        handler: { kind: "javascript", source: "return {sum:args.a+args.b};" },
      },
    ],
  };
}
async function fixture(
  run: (s: McpAppsService, path: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-app-builder-")),
    path = join(dir, "apps.sqlite"),
    s = new McpAppsService(path);
  try {
    await run(s, path);
  } finally {
    s.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const publish = (s: McpAppsService, spec = sampleSpec(), version = 0) =>
  s.manage("alice", {
    action: "publish",
    appId: spec.appId,
    spec_json: JSON.stringify(spec),
    expectedVersion: version,
  }) as Promise<any>;

test("historical cards authorize only their exact release in the readable thread and connection", () =>
  fixture(async s => {
    await publish(s);
    const opened = await s.manage("alice", { action: "open", appId: "calculator" }) as any;
    const context = { sender: null, resourceOwner: { id: "bob", assertCurrent() {} } };
    let sequence = 100;
    const waiting = new Map<number, (value: any) => void>();
    const session = new McpAppsRpcSession(s, frame => {
      const result = JSON.parse(frame); waiting.get(result.id)?.(result); waiting.delete(result.id);
    });
    const rpc = (method: string, params: unknown) => new Promise<any>(resolve => {
      const id = ++sequence; waiting.set(id, resolve);
      assert.equal(session.receive(JSON.stringify({ id, method, params }), context), true);
    });
    const resource = { threadId: "shared", server: opened.server, uri: opened.resourceUri };
    const call = { threadId: "shared", server: opened.server, tool: "calculate", arguments: { a: 7, b: 8 },
      _meta: { [MCP_APP_RESOURCE_META]: opened.resourceUri } };
    assert.match((await rpc("mcpServer/resource/read", resource)).error.message, /inactive/);
    // Client-supplied envelopes, arbitrary text and unrelated tools are not authority.
    const item = { type: "dynamicToolCall", namespace: "opencraft_apps", tool: "manage", status: "completed", success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify(opened) }] };
    session.receive(JSON.stringify({ id: 1, method: "thread/read", params: { threadId: "shared", envelope: opened } }), context);
    session.project(JSON.stringify({ id: 1, result: { thread: { id: "shared", turns: [{ items: [
      { type: "userMessage", content: JSON.stringify(opened) }, { ...item, namespace: "forged" }, { ...item, success: false },
    ] }] } } }), context);
    assert.match((await rpc("mcpServer/resource/read", resource)).error.message, /inactive/);
    // Engine-owned historical builder result, unchanged pre-upgrade server/URI.
    session.receive(JSON.stringify({ id: 2, method: "thread/read", params: { threadId: "shared" } }), context);
    session.project(JSON.stringify({ id: 2, result: { thread: { id: "shared", turns: [{ items: [item] }] } } }), context);
    assert.equal((await rpc("mcpServer/resource/read", resource)).result.contents[0].text, sampleSpec().uiHtml);
    assert.equal((await rpc("mcpServer/tool/call", call)).result.structuredContent.sum, 15);
    assert.match((await rpc("mcpServer/tool/call", { ...call, threadId: "other" })).error.message, /inactive/);
    assert.match((await rpc("mcpServer/resource/read", { ...resource, uri: opened.resourceUri + "?forged" })).error.message, /inactive/);
    assert.match((await rpc(MCP_APPS_METHOD, { action: "get", appId: "calculator" })).error.message, /not found/);
    assert.deepEqual((await rpc(MCP_APPS_METHOD, { action: "list" })).result.apps, []);
    session.receive(JSON.stringify({ id: 3, method: "mcpServerStatus/list", params: { threadId: "shared" } }), context);
    const inventory = JSON.parse(session.project(JSON.stringify({ id: 3, result: { data: [], nextCursor: null } }), context));
    assert.equal(inventory.result.data.find((r: any) => r.name === opened.server).resources[0].uri, opened.resourceUri);
    // Same App ID/revision under another owner must never substitute another card's code.
    const bobSpec = sampleSpec(); bobSpec.uiHtml = bobSpec.uiHtml.replace("Ready", "Bob");
    bobSpec.tools[0]!.handler.source = "return {sum:999};";
    await s.manage("bob", { action: "publish", appId: "calculator", expectedVersion: 0, spec_json: JSON.stringify(bobSpec) });
    assert.equal((await rpc("mcpServer/tool/call", call)).result.structuredContent.sum, 15);
    const { _meta, ...legacyCall } = call;
    assert.match((await rpc("mcpServer/tool/call", legacyCall)).error.message, /Ambiguous/);
    let attached = true;
    const late = s.handle("bob", "mcpServer/tool/call", call, () => {},
      () => attached ? [{ server: opened.server, resourceUri: opened.resourceUri }] : []);
    attached = false;
    await assert.rejects(late, /not found|inactive/, "losing thread evidence fences an in-flight result");
    await s.manage("alice", { action: "unpublish", appId: "calculator", expectedVersion: 1 });
    assert.match((await rpc("mcpServer/tool/call", call)).error.message, /inactive/);
    session.close();
    let reconnectReply: any;
    const reconnected = new McpAppsRpcSession(s, value => { reconnectReply = JSON.parse(value); });
    reconnected.receive(JSON.stringify({ id: 1, method: "mcpServer/resource/read", params: resource }), context);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(reconnectReply.error, "a new connection must reacquire historical evidence");
    await assert.rejects(s.handle("bob", "mcpServer/resource/read", resource), /not found/);
    reconnected.close();
  }));

test("DSH history pages, initial resume pages and live completed items retain legacy card references", () =>
  fixture(async s => {
    await publish(s);
    const opened = await s.manage("alice", { action: "open", appId: "calculator" }) as any;
    const item = { type: "dynamicToolCall", namespace: "deepseek-harness", tool: "opencraft_apps__manage", status: "completed", success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify(opened) }] };
    const context = { sender: null, resourceOwner: { id: "bob", assertCurrent() {} } };
    for (const [method, result] of [
      ["thread/resume", { thread: { id: "shared", turns: [] }, initialTurnsPage: { data: [{ items: [item] }] } }],
      ["thread/turns/list", { data: [{ items: [item] }] }],
      ["thread/items/list", { data: [{ turnId: "turn", item }] }],
      ["notification", null],
    ] as const) {
      let response: any;
      const session = new McpAppsRpcSession(s, f => { response = JSON.parse(f); });
      if (method === "notification") session.project(JSON.stringify({ method: "item/completed", params: { threadId: "shared", item } }), context);
      else {
        session.receive(JSON.stringify({ id: 1, method, params: { threadId: "shared" } }), context);
        session.project(JSON.stringify({ id: 1, result }), context);
      }
      session.receive(JSON.stringify({ id: 2, method: "mcpServer/resource/read", params: { threadId: "shared", server: opened.server, uri: opened.resourceUri } }), context);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.ok(response.result, `${method}: ${JSON.stringify(response)}`);
      session.project(JSON.stringify({ method: "thread/closed", params: { threadId: "shared" } }), context);
      session.receive(JSON.stringify({ id: 3, method: "mcpServer/resource/read", params: { threadId: "shared", server: opened.server, uri: opened.resourceUri } }), context);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.ok(response.error, "closing a thread drops its connection evidence");
      session.close();
    }
  }));
test("validation, owned releases, input/output schemas, CAS and immutable resources", () =>
  fixture(async (s) => {
    const spec = sampleSpec();
    assert.match(
      JSON.stringify(await s.manage("alice", { action: "help" })),
      /expectedVersion/,
    );
    assert.deepEqual(
      await s.manage("alice", {
        action: "validate",
        spec_json: JSON.stringify(spec),
      }),
      { valid: true, appId: "calculator" },
    );
    const r = await publish(s);
    assert.equal(r.activeRevision, 1);
    assert.equal(r.version, 1);
    const opened: any = await s.manage("alice", {
      action: "open",
      appId: spec.appId,
    });
    const params = {
      server: opened.server,
      tool: "calculate",
      arguments: { a: 7, b: 8 },
    };
    assert.equal(
      (await s.handle("alice", "mcpServer/tool/call", params)).structuredContent
        .sum,
      15,
    );
    await assert.rejects(
      s.handle("bob", "mcpServer/tool/call", params),
      /inactive/,
    );
    await assert.rejects(
      s.manage("bob", { action: "get", appId: spec.appId }),
      /not found/,
    );
    await assert.rejects(
      s.handle("alice", "mcpServer/tool/call", {
        ...params,
        arguments: { a: "7", b: 8 },
      }),
      /inputSchema/,
    );
    await assert.rejects(publish(s, spec, 0), /changed/);
    const resource: any = await s.handle("alice", "mcpServer/resource/read", {
      server: opened.server,
      uri: opened.resourceUri,
      originCallId: "call-1",
    });
    assert.equal(resource.originCallId, "call-1");
    assert.equal(resource.contents[0].text, spec.uiHtml);
    const invalid = sampleSpec();
    invalid.tools[0]!.handler.source = "return (";
    await assert.rejects(publish(s, invalid, 1), /validation/);
    assert.equal(
      ((await s.manage("alice", { action: "open", appId: spec.appId })) as any)
        .server,
      opened.server,
    );
  }));
test("draft is separate; rollback/unpublish/delete revoke tools and recover durable revisions", () =>
  fixture(async (s, path) => {
    await publish(s);
    const first: any = await s.manage("alice", {
      action: "open",
      appId: "calculator",
    });
    const spec = sampleSpec();
    spec.uiHtml = spec.uiHtml.replace("Ready", "Updated");
    await s.manage("alice", {
      action: "saveDraft",
      appId: spec.appId,
      spec_json: JSON.stringify(spec),
      expectedVersion: 1,
    });
    assert.equal(
      ((await s.manage("alice", { action: "open", appId: spec.appId })) as any)
        .server,
      first.server,
    );
    await publish(s, spec, 2);
    const second: any = await s.manage("alice", {
      action: "open",
      appId: spec.appId,
    });
    assert.notEqual(second.resourceUri, first.resourceUri);
    await assert.rejects(
      s.handle("alice", "mcpServer/tool/call", {
        server: first.server,
        tool: "calculate",
        arguments: { a: 1, b: 2 },
      }),
      /inactive/,
    );
    await s.manage("alice", {
      action: "rollback",
      appId: spec.appId,
      revision: 1,
      expectedVersion: 3,
    });
    const recovered = new McpAppsService(path);
    try {
      assert.equal(recovered.outcome.status, "up-to-date");
      assert.equal(
        (
          (await recovered.manage("alice", {
            action: "open",
            appId: spec.appId,
          })) as any
        ).resourceUri,
        first.resourceUri,
      );
    } finally {
      recovered.close();
    }
    await s.manage("alice", {
      action: "unpublish",
      appId: spec.appId,
      expectedVersion: 4,
    });
    await assert.rejects(
      s.manage("alice", { action: "open", appId: spec.appId }),
      /inactive/,
    );
    assert.equal(
      ((await s.manage("alice", { action: "get", appId: spec.appId })) as any)
        .releases.length,
      2,
    );
    await s.manage("alice", {
      action: "delete",
      appId: spec.appId,
      expectedVersion: 5,
    });
    assert.equal(s.store.revisions("alice", spec.appId).length, 0);
    await assert.rejects(publish(s, spec, 0), /changed/);
    const recreated = await publish(s, spec, 6);
    assert.equal(recreated.activeRevision, 3);
    await assert.rejects(
      s.handle("alice", "mcpServer/tool/call", {
        server: first.server,
        tool: "calculate",
        arguments: { a: 1, b: 2 },
      }),
      /inactive/,
    );
  }));
test("worker rejects host escape, infinite execution, async and oversized output", async () => {
  const run = (source: string) =>
    javascript({ source, args: {}, context: { appId: "test" } });
  assert.deepEqual(
    await run(
      "return {node:typeof process,require:typeof require,fetch:typeof fetch};",
    ),
    { node: "undefined", require: "undefined", fetch: "undefined" },
  );
  await assert.rejects(run("while(true){}"), /limits/);
  await assert.rejects(run("return Promise.resolve(1)"), /limits/);
  await assert.rejects(run('return "x".repeat(200000)'), /limits/);
  await assert.rejects(run('return Function("return process")()'), /limits/);
  await assert.rejects(run("return new Array(100000000).fill(1)"), /limits/);
  assert.throws(
    () =>
      validateSpec(
        JSON.stringify({
          ...sampleSpec(),
          tools: [
            {
              ...sampleSpec().tools[0],
              inputSchema: {
                type: "object",
                properties: { x: { type: "string", pattern: "(a+)+$" } },
              },
            },
          ],
        }),
      ),
    /keyword/,
  );
});
test("late publish cannot commit after resource authority expires; no retry", () =>
  fixture(async (s) => {
    let checks = 0;
    await assert.rejects(
      s.manage(
        "alice",
        {
          action: "publish",
          appId: "calculator",
          spec_json: JSON.stringify(sampleSpec()),
          expectedVersion: 0,
        },
        () => {
          if (++checks > 1) throw new Error("revoked");
        },
      ),
      /revoked/,
    );
    assert.equal(s.store.get("alice", "calculator"), null);
  }));
test("gateway negotiation, native inventory preservation, exact owner and disconnect fences", () =>
  fixture(async (s) => {
    const frames: any[] = [],
      session = new McpAppsRpcSession(s, (f) => frames.push(JSON.parse(f)));
    let valid = true;
    const context = {
      sender: null,
      resourceOwner: {
        id: "alice",
        assertCurrent() {
          if (!valid) throw new Error("revoked");
        },
      },
    };
    assert.equal(
      session.receive(JSON.stringify({ id: 1, method: "initialize" }), context),
      false,
    );
    assert.equal(
      JSON.parse(
        session.project(
          JSON.stringify({
            id: 1,
            result: { capabilities: { extensions: { existing: true } } },
          }),
          context,
        ),
      ).result.capabilities.extensions["opencraft/mcp-app-builder"].version,
      1,
    );
    session.receive(
      JSON.stringify({ id: 2, method: "mcpServerStatus/list", params: {} }),
      context,
    );
    const merged = JSON.parse(
      session.project(
        JSON.stringify({
          id: 2,
          result: { data: [{ name: "external" }], nextCursor: "next" },
        }),
        context,
      ),
    );
    assert.equal(merged.result.data[0].name, "external");
    assert.equal(merged.result.data[1].name, MCP_APPS_SERVER);
    assert.equal(merged.result.nextCursor, "next");
    session.receive(
      JSON.stringify({
        id: 3,
        method: MCP_APPS_METHOD,
        params: { action: "list", owner: "bob" },
      }),
      context,
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.match(frames[0].error.message, /Unknown management field/);
    valid = false;
    session.receive(
      JSON.stringify({
        id: 4,
        method: MCP_APPS_METHOD,
        params: { action: "list" },
      }),
      context,
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.match(frames[1].error.message, /revoked/);
    session.close();
  }));
test("N+1 managed upgrade preserves app rows; changed migration checksum rejected", () =>
  fixture(async (s, path) => {
    await publish(s);
    const next = [
      ...appMigrations,
      {
        version: 2,
        name: "test-upgrade",
        sql: "CREATE TABLE test_upgrade (id TEXT PRIMARY KEY) STRICT;",
      },
    ];
    const opened = openManagedDatabase({
      path,
      migrations: next,
      legacyPolicy: "reject",
    });
    try {
      assert.equal(opened.outcome.status, "migrated");
      assert.equal(
        opened.database.prepare("SELECT count(*) AS n FROM apps").get()!.n,
        1,
      );
    } finally {
      opened.database.close();
    }
    assert.throws(
      () =>
        openManagedDatabase({
          path,
          migrations: [
            {
              ...appMigrations[0]!,
              sql: appMigrations[0]!.sql + "\n-- changed",
            },
            next[1]!,
          ],
          legacyPolicy: "reject",
        }),
      /migration|history|checksum/i,
    );
  }));

test("packaged worker uses its own pinned runtime closure outside workstation dependencies", async () => {
  const { build } = await import("esbuild"),
    { copyMcpAppRuntime } = await import(
      "../../scripts/package-mcp-app-runtime.mjs"
    ),
    { writeFile } = await import("node:fs/promises"),
    { spawnSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "opencraft-quickjs-package-"));
  try {
    const runtimeDependencies = await copyMcpAppRuntime(
      join(dir, "node_modules"),
    );
    await build({
      entryPoints: ["packages/mcp-apps/src/javascript.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: join(dir, "guest.mjs"),
    });
    await writeFile(
      join(dir, "probe.mjs"),
      'import {javascript} from "./guest.mjs"; const value=await javascript({source:"return {value:args.n*3}",args:{n:7},context:{}}); if(value.value!==21)throw Error("worker mismatch"); console.log("packaged worker ready");',
    );
    const result = spawnSync(process.execPath, [join(dir, "probe.mjs")], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /packaged worker ready/);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "opencraft-app-runtime-fixture",
        version: "0.0.0",
        type: "module",
        files: ["guest.mjs", "probe.mjs"],
        dependencies: runtimeDependencies,
        bundleDependencies: Object.keys(runtimeDependencies),
      }),
    );
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(packed.status, 0, packed.stderr);
    const archive = join(dir, JSON.parse(packed.stdout)[0].filename);
    const unpacked = await mkdtemp(
      join(tmpdir(), "opencraft-quickjs-installed-"),
    );
    try {
      const tar = spawnSync("tar", ["-xzf", archive, "-C", unpacked], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(tar.status, 0, tar.stderr);
      const installed = spawnSync(
        process.execPath,
        [join(unpacked, "package/probe.mjs")],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(installed.status, 0, installed.stderr);
      assert.match(installed.stdout, /packaged worker ready/);
    } finally {
      await rm(unpacked, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent publication commits one release; unpublish fences in-flight execution", () =>
  fixture(async (s) => {
    const settled = await Promise.allSettled([publish(s), publish(s)]);
    assert.equal(settled.filter((v) => v.status === "fulfilled").length, 1);
    assert.equal(s.store.revisions("alice", "calculator").length, 1);
    const opened: any = await s.manage("alice", {
      action: "open",
      appId: "calculator",
    });
    const pending = s.handle("alice", "mcpServer/tool/call", {
      server: opened.server,
      tool: "calculate",
      arguments: { a: 1, b: 2 },
    });
    await s.manage("alice", {
      action: "unpublish",
      appId: "calculator",
      expectedVersion: 1,
    });
    await assert.rejects(pending, /inactive/);
  }));

test("native transport keeps logical client/identity fences and retires disconnected work", () =>
  fixture(async (s) => {
    const { McpAppsTransport } = await import(
      "../../packages/mcp-apps/src/transport"
    );
    const { LOGICAL_CLIENT_FIELD: field } = await import(
      "@opencraft/app-host-protocol"
    );
    let receive: (v: string) => void = () => {};
    const wire: string[] = [];
    const inner = {
      status: { state: "open" as const },
      connect: async () => {},
      send: async (f: string) => {
        wire.push(f);
      },
      subscribeMessage: (l: (f: string) => void) => {
        receive = l;
        return () => {};
      },
      subscribeStatus: () => () => {},
      close: async () => {},
    };
    const transport = new McpAppsTransport(inner, s),
      frames: any[] = [];
    transport.subscribeMessage((f) => frames.push(JSON.parse(f)));
    const context = {
      sender: null,
      resourceOwner: { id: "alice", assertCurrent() {} },
    };
    await transport.sendWithContext(
      JSON.stringify({ id: 1, method: "initialize", [field]: "client-a" }),
      context,
    );
    receive(
      JSON.stringify({
        id: 1,
        result: { capabilities: { extensions: {} } },
        [field]: "client-a",
      }),
    );
    assert.equal(
      frames[0].result.capabilities.extensions["opencraft/mcp-app-builder"]
        .version,
      1,
    );
    await transport.sendWithContext(
      JSON.stringify({
        id: 2,
        method: MCP_APPS_METHOD,
        params: { action: "list" },
        [field]: "client-a",
      }),
      context,
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(frames[1][field], "client-a");
    await assert.rejects(
      transport.sendWithContext(
        JSON.stringify({
          id: 3,
          method: MCP_APPS_METHOD,
          params: { action: "list" },
          [field]: "client-a",
        }),
        { sender: null, resourceOwner: { id: "bob", assertCurrent() {} } },
      ),
      /identity changed/,
    );
    const count = frames.length;
    await transport.sendWithContext(
      JSON.stringify({
        id: 4,
        method: MCP_APPS_METHOD,
        params: { action: "list" },
        [field]: "client-a",
      }),
      context,
    );
    await transport.sendWithContext(
      JSON.stringify({
        method: "runtime/client/disconnect",
        [field]: "client-a",
      }),
      context,
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(frames.length, count);
    assert.equal(wire.length, 2);
    await transport.close();
  }));
