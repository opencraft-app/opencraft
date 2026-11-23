import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WorkerOwner } from "@opencraft/worker-owner";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { MembershipStore } from "@opencraft/access-control";
import { SandboxConfigurationError } from "@opencraft/plugin-assets/server/configurations";
import type { PersonalMcpPort, ExecutionSessionLocator } from "@opencraft/plugin-assets/server/personal-mcp";
import { personalMcpService } from "@opencraft/plugin-assets/server/personal-mcp";
import { OpenCraftHostStateDatabase } from "@opencraft/opencraft-daemon/opencraft-host-state-database";
import { ExecutionLeaseStore } from "@opencraft/opencraft-daemon/execution-lease-store";
import type { CapabilitySession } from "@opencraft/session-capabilities";
import { createPersonalMcpProvider } from "../../apps/headless-server/src/personal-mcp-provider.js";
import type { WorkspaceActorAdmission } from "../../apps/headless-server/src/workspaces/actor-authority.js";
import { SYNTHETIC_MCP } from "../fixtures/personal-mcp-service.js";

const TOKEN = "syn_worker-only-token";
const OTHER_TOKEN = "syn_other-person-token";
const flag = () => {
  const value = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(value, 0, 1);
  return value;
};
const waitFor = async (predicate: () => boolean) => {
  const until = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < until, "timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const rejectsWith = (code: string) => (error: unknown) =>
  error instanceof Error && (error as { code?: string }).code === code;

async function fixture(t: test.TestContext, options: { provenance?: boolean; started?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "personal-mcp-")),
    directory = join(root, "data");
  const server = await openServerDatabase(directory),
    actors = new ActorStore(server),
    members = new MembershipStore(server);
  const human = (subject: string) =>
    actors.resolveHuman({ provider: "fixture", subject, displayName: subject, expiresAt: Date.now() + 120000 })!;
  const actor = human("alice"),
    other = human("bob");
  for (const id of [actor.actorId, other.actorId]) members.setActor(id, "member", true, "fixture");
  const codexDirectory = join(directory, "codex");
  await mkdir(codexDirectory, { recursive: true });
  const codex = new OpenCraftHostStateDatabase(codexDirectory),
    leases = new ExecutionLeaseStore(codex.database);
  const run = (threadId: string, owner: { actorId: string; generation: number }, started = true) => {
    leases.capture(threadId, "input", {
      principal: {
        provider: "fixture",
        subject: owner === actor ? "alice" : "bob",
        ...(options.provenance === false ? {} : { actorId: owner.actorId, actorGeneration: owner.generation }),
      },
      ownership: "human",
    });
    const executionId = leases.begin(threadId, "input", "engine");
    if (started) leases.started(threadId, "turn", "input", "engine");
    return executionId;
  };
  const executionId = run("thread", actor, options.started !== false);
  run("thread-bob", other);
  const context = (owner = actor) => ({
    host: { id: "local-codex", engine: "codex" },
    actor: { id: owner.actorId, generation: owner.generation, bindings: [] },
  });
  const session: CapabilitySession = {
    serverId: "server:fixture:codex",
    threadId: "thread",
    execution: {
      inputId: "input",
      executionId,
      ...(options.started !== false ? { turnId: "turn", incarnation: "engine" } : {}),
    },
    context: context(),
  };
  const locator: ExecutionSessionLocator = {
    hostId: "local-codex",
    threadId: "thread",
    inputId: "input",
    executionId,
  };

  // A real MCP server that reflects the bearer it receives, so redaction is
  // exercised on both the catalog and the call result.
  let calls = 0,
    held: Promise<void> | undefined,
    entered: (() => void) | undefined;
  const bearers: string[] = [];
  const http = createServer((request: IncomingMessage, response) => {
    const bearer = String(request.headers.authorization ?? "").replace(/^Bearer /u, "");
    bearers.push(bearer);
    if (bearer !== TOKEN && bearer !== OTHER_TOKEN) {
      response.writeHead(401).end();
      return;
    }
    const peer = new Server({ name: "synthetic", version: "1" }, { capabilities: { tools: {} } });
    peer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "whoami", description: `Echo ${bearer}`, inputSchema: { type: "object" as const } }],
    }));
    peer.setRequestHandler(CallToolRequestSchema, async () => {
      calls++;
      entered?.();
      if (held) await held;
      return { content: [{ type: "text", text: `caller ${bearer}` }] };
    });
    void (async () => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await peer.connect(transport);
      await transport.handleRequest(request, response);
    })()
      .catch(() => response.end())
      .finally(() => void peer.close());
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address === "object");

  const { owner, ready } = await WorkerOwner.open<PersonalMcpPort, { personalMcp: boolean }>(
    new URL("../fixtures/personal-mcp.worker.ts", import.meta.url),
    {
      name: "Synthetic personal MCP vault owner",
      workerData: { directory, origin: `http://127.0.0.1:${address.port}` },
      errors: [SandboxConfigurationError],
    },
  );
  // Every frame Main exchanges with the Worker, serialized.
  const frames: string[] = [];
  const record = (value: unknown) =>
    frames.push(JSON.stringify(value, (_k, v) => (v instanceof Int32Array ? [...v] : v)) ?? "undefined");
  const port = new Proxy(owner.call, {
    get(target, name) {
      const method = target[name as keyof PersonalMcpPort] as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        record(args);
        try {
          const value = await method(...args);
          record(value);
          return value;
        } catch (error) {
          record({ message: (error as Error).message, code: (error as { code?: string }).code });
          throw error;
        }
      };
    },
  }) as PersonalMcpPort;
  const access = (id = actor.actorId): WorkspaceActorAdmission => ({
    actorId: id,
    generation: actors.get(id)!.generation,
    membershipRevision: members.revocationRevision(id, actors.bindings(id)),
    expiresAt: Date.now() + 120000,
    requestPermit: flag(),
    resourcePermit: flag(),
  });
  const authorize = (ref: { actorId: string; generation: number }) => {
    const current = actors.get(ref.actorId);
    if (!current?.enabled || current.generation !== ref.generation || !members.actorMembership(ref.actorId)?.enabled)
      throw Error("Retired");
    return access(ref.actorId);
  };
  const provider = createPersonalMcpProvider({ service: SYNTHETIC_MCP, port, authorize });
  t.after(async () => {
    provider.close();
    await owner.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    codex.close();
    members.close();
    actors.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    actors,
    members,
    actor,
    other,
    leases,
    session,
    context,
    locator,
    port,
    ready,
    access,
    provider,
    frames,
    bearers,
    calls: () => calls,
    hold() {
      let release!: () => void;
      held = new Promise<void>((resolve) => (release = resolve));
      return { entered: new Promise<void>((resolve) => (entered = resolve)), release };
    },
  };
}
const id = SYNTHETIC_MCP.id;

test("a personal token is stored, replaced and deleted only under the owner's current admission", async (t) => {
  const f = await fixture(t);
  assert.equal(f.ready.personalMcp, true);
  assert.deepEqual(await f.port.personalMcpTokenState(f.access(), id), { revision: 0, configured: false });
  assert.deepEqual(await f.port.personalMcpTokenReplace(f.access(), id, 0, TOKEN), { revision: 1, configured: true });
  // Stale revisions, tokens outside the configured pattern and unknown services are refused.
  await assert.rejects(f.port.personalMcpTokenReplace(f.access(), id, 0, TOKEN), rejectsWith("conflict"));
  await assert.rejects(f.port.personalMcpTokenReplace(f.access(), id, 1, "not-a-token"), rejectsWith("invalid"));
  await assert.rejects(f.port.personalMcpTokenReplace(f.access(), "other", 1, TOKEN), rejectsWith("unavailable"));
  assert.deepEqual(await f.port.personalMcpTokenReplace(f.access(), id, 1, OTHER_TOKEN), {
    revision: 2,
    configured: true,
  });
  // Partitioned per Actor: another person sees and writes only their own.
  assert.deepEqual(await f.port.personalMcpTokenState(f.access(f.other.actorId), id), {
    revision: 0,
    configured: false,
  });
  assert.deepEqual(await f.port.personalMcpTokenReplace(f.access(), id, 2, null), { revision: 3, configured: false });
  // A forged or expired proof is not admission.
  await assert.rejects(f.port.personalMcpTokenState({ ...f.access(), generation: 99 }, id), rejectsWith("forbidden"));
  await assert.rejects(
    f.port.personalMcpTokenState({ ...f.access(), expiresAt: Date.now() - 1 }, id),
    rejectsWith("forbidden"),
  );
  const retired = f.access();
  Atomics.store(retired.resourcePermit, 0, 0);
  await assert.rejects(f.port.personalMcpTokenReplace(retired, id, 3, TOKEN), rejectsWith("forbidden"));
});

for (const revocation of ["actor", "member"] as const)
  test(`a revoked ${revocation} can neither manage its token nor reach the service`, async (t) => {
    const f = await fixture(t);
    await f.port.personalMcpTokenReplace(f.access(), id, 0, TOKEN);
    const before = f.access();
    if (revocation === "actor") f.actors.setEnabled(f.actor.actorId, false, "fixture");
    else f.members.setActor(f.actor.actorId, "member", false, "fixture");
    await assert.rejects(f.port.personalMcpTokenState(before, id), rejectsWith("forbidden"));
    await assert.rejects(f.port.personalMcpTokenReplace(before, id, 1, null), rejectsWith("forbidden"));
    // Core's session reader no longer names the Actor as the run's owner.
    assert.equal(await f.port.personalMcpOwner(id, f.locator, false), null);
    await assert.rejects(
      f.port.personalMcpBegin(before, id, f.locator, { kind: "catalog" }, flag()),
      rejectsWith("forbidden"),
    );
    assert.deepEqual(f.bearers, []);
  });

test("a session resolves to the Actor that owns it, and the provider reaches the service as that person", async (t) => {
  const f = await fixture(t);
  await f.port.personalMcpTokenReplace(f.access(), id, 0, TOKEN);
  assert.deepEqual(await f.port.personalMcpOwner(id, f.locator, true), {
    actorId: f.actor.actorId,
    generation: f.actor.generation,
  });
  assert.deepEqual(
    await f.port.personalMcpOwner(id, { hostId: "local-codex", threadId: "thread-bob", inputId: "input" }, true),
    {
      actorId: f.other.actorId,
      generation: f.other.generation,
    },
  );
  await f.provider.refresh!(f.session);
  const tools = f.provider.tools(f.session);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["synthetic_whoami"],
  );
  const result = await f.provider.call(
    { ...f.session, execution: { ...f.session.execution, callId: "call-1" } },
    "synthetic_whoami",
    {},
    AbortSignal.timeout(5000),
  );
  assert.equal(f.calls(), 1);
  assert.ok(JSON.stringify(result).includes("[redacted]"));
  assert.ok(f.bearers.every((bearer) => bearer === TOKEN));
});

test("no token value reaches Main frames or logs", async (t) => {
  const f = await fixture(t);
  const logged: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((name) => console[name]);
  for (const name of methods) console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    await f.port.personalMcpTokenReplace(f.access(), id, 0, TOKEN);
    await f.provider.refresh!(f.session);
    const result = await f.provider.call(f.session, "synthetic_whoami", {}, AbortSignal.timeout(5000));
    f.provider.formatResult!(result);
    await f.port.personalMcpTokenState(f.access(), id);
    await assert.rejects(f.port.personalMcpTokenReplace(f.access(), id, 0, OTHER_TOKEN));
    await assert.rejects(f.port.personalMcpTokenReplace(f.access(), id, 1, `bad ${TOKEN}`));
  } finally {
    methods.forEach((name, index) => (console[name] = originals[index]!));
  }
  assert.ok(f.bearers.includes(TOKEN), "the token did reach the service");
  const outbound = f.frames.filter((frame) => frame.includes(TOKEN) || frame.includes(OTHER_TOKEN));
  // Only the caller's own write request carries a token, Main-to-Worker.
  assert.deepEqual(
    outbound.map((frame) => JSON.parse(frame)[3]),
    [TOKEN, OTHER_TOKEN, `bad ${TOKEN}`],
  );
  const inbound = f.frames.filter((frame) => !outbound.includes(frame)).join("\n");
  assert.ok(inbound.length > 0 && !inbound.includes(TOKEN) && !inbound.includes("worker-only"));
  assert.ok(!logged.join("\n").includes(TOKEN));
});

test("a foreign session, a foreign Actor and a session without Actor provenance cannot borrow a token", async (t) => {
  const f = await fixture(t);
  await f.port.personalMcpTokenReplace(f.access(), id, 0, TOKEN);
  await f.port.personalMcpTokenReplace(f.access(f.other.actorId), id, 0, OTHER_TOKEN);
  // Another person's admission cannot run on Alice's session, nor Alice on Bob's.
  await assert.rejects(
    f.port.personalMcpBegin(f.access(f.other.actorId), id, f.locator, { kind: "catalog" }, flag()),
    rejectsWith("unavailable"),
  );
  // A session core attributes to someone else, or with no resolved Actor, has no tools.
  // Core and the Worker's session reader must name the same owner.
  await assert.rejects(f.provider.refresh!({ ...f.session, context: f.context(f.other) }));
  assert.deepEqual(f.provider.tools({ ...f.session, context: f.context(f.other) }), []);
  await f.provider.refresh!({ ...f.session, context: { host: f.session.context!.host } });
  assert.deepEqual(f.provider.tools({ ...f.session, context: { host: f.session.context!.host } }), []);
  // Unknown Thread, input or execution.
  for (const locator of [
    { ...f.locator, threadId: "foreign" },
    { ...f.locator, inputId: "other" },
    { ...f.locator, executionId: "other" },
  ])
    assert.equal(await f.port.personalMcpOwner(id, locator, false), null);
  // Another Host's records never name this session's owner.
  assert.equal(
    await f.port.personalMcpOwner(id, { ...f.locator, hostId: "opencraft-server" }, false).catch(() => null),
    null,
  );
  // A handle is bound to the original Actor and session.
  const handle = await f.port.personalMcpBegin(f.access(), id, f.locator, { kind: "catalog" }, flag());
  await assert.rejects(f.port.personalMcpStatus(f.access(f.other.actorId), id, f.locator, handle));
  await assert.rejects(f.port.personalMcpStatus(f.access(), id, { ...f.locator, threadId: "foreign" }, handle));
  await f.port.personalMcpForget(handle);
  assert.ok(!f.bearers.includes(OTHER_TOKEN));
});

test("an execution without Actor provenance is never matched to a same-named person", async (t) => {
  const f = await fixture(t, { provenance: false });
  await f.port.personalMcpTokenReplace(f.access(), id, 0, TOKEN);
  assert.equal(await f.port.personalMcpOwner(id, f.locator, false), null);
  await f.provider.refresh!(f.session);
  assert.deepEqual(f.provider.tools(f.session), []);
  assert.deepEqual(f.bearers, []);
});

test("a pending input may list declarations but cannot call before its native Turn", async (t) => {
  const f = await fixture(t, { started: false });
  await f.port.personalMcpTokenReplace(f.access(), id, 0, TOKEN);
  await f.provider.refresh!(f.session);
  assert.equal(f.provider.tools(f.session)[0]?.name, "synthetic_whoami");
  await assert.rejects(f.provider.call(f.session, "synthetic_whoami", {}, AbortSignal.timeout(5000)));
  assert.equal(f.calls(), 0);
});

test("a stale session is refused: an ended Turn cancels its call and its finished output", async (t) => {
  const f = await fixture(t);
  await f.port.personalMcpTokenReplace(f.access(), id, 0, TOKEN);
  await f.provider.refresh!(f.session);
  const gate = f.hold();
  const call = f.provider.call(f.session, "synthetic_whoami", {}, AbortSignal.timeout(5000));
  const rejected = assert.rejects(call);
  await gate.entered;
  f.leases.finished("thread", "turn");
  await rejected;
  gate.release();
  assert.equal(f.calls(), 1);
  assert.equal(await f.port.personalMcpOwner(id, f.locator, true), null);
  await assert.rejects(
    f.port.personalMcpBegin(f.access(), id, f.locator, { kind: "call", name: "synthetic_whoami", args: {} }, flag()),
    rejectsWith("unavailable"),
  );
  await f.provider.refresh!(f.session);
  assert.deepEqual(f.provider.tools(f.session), []);
});

test("a token replaced during a call retires the operation instead of reusing the old one", async (t) => {
  const f = await fixture(t);
  await f.port.personalMcpTokenReplace(f.access(), id, 0, TOKEN);
  await f.provider.refresh!(f.session);
  const gate = f.hold();
  const rejected = assert.rejects(f.provider.call(f.session, "synthetic_whoami", {}, AbortSignal.timeout(5000)));
  await gate.entered;
  await f.port.personalMcpTokenReplace(f.access(), id, 1, OTHER_TOKEN);
  await rejected;
  gate.release();
  assert.equal(f.calls(), 1);
});

test("service definitions are validated", () => {
  assert.equal(personalMcpService(SYNTHETIC_MCP).id, "synthetic");
  for (const change of [
    { id: "Bad id" },
    { prefix: "noUnderscore" },
    { endpoint: "http://mcp.example.test/mcp" },
    { endpoint: "https://user:secret@mcp.example.test/mcp" },
    { service: "document-shadow" },
    { service: "github.com" },
    { tokenPattern: /syn_/gu },
  ])
    assert.throws(() => personalMcpService({ ...SYNTHETIC_MCP, ...change }));
});
