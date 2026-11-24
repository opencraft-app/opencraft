/** Execution identity across PID namespaces (workspace-host-split §3.4, P4-5): a Gateway
 * takes the incarnation an owner attests in its own namespace and reports over its
 * workspace endpoint, attributed to the workspace agent incarnation bound around the
 * report. Nothing here reads the reported PID from this process's /proc. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSandboxPool,
  createWorkspaceRuntime,
  parseSandboxEnvironmentUri,
  parseWorkspaceEndpointUri,
  type WorkspacePlacementRecord,
} from "@opencraft/sandbox";
import { inProcessHarness } from "./fixtures/sandbox-endpoint-backends";
import { attachEngineHost } from "../../apps/headless-server/src/server-deployment/engine-host-client.mjs";
import { attachDshHost } from "../../apps/headless-server/src/server-deployment/dsh-host-client.mjs";
import { ExecutionLeaseStore } from "../../apps/opencraft-daemon/src/execution-lease-store.js";
import { ThreadIdentityDatabase } from "../../apps/opencraft-daemon/src/thread-identity-database.js";

// Above Linux's PID_MAX_LIMIT (2^22): this PID cannot exist in this namespace, so any local
// /proc resolution would fail. It is only meaningful inside the owner's environment.
const FOREIGN_PID = 2 ** 22 + 7;

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  return { server, port };
}

/** One workspace environment whose agent incarnation the test restarts at will. */
async function workspace(t: test.TestContext, endpoint: "pi" | "dsh") {
  const harness = await inProcessHarness();
  const pool = await createSandboxPool(
    { id: "identity", capacity: harness.resources, defaults: harness.resources },
    harness.backend,
  );
  const agent = { id: "a".repeat(32) };
  const control = await harness.listen((socket) => {
    let text = "";
    socket.on("data", (data) => {
      text += data;
      if (!text.includes("\n")) return;
      socket.end(
        JSON.stringify({
          protocol: 1,
          type: "healthy",
          state: "ready",
          roles: ["brain"],
          incarnation: { id: agent.id, evidence: "e", startedAt: new Date(0).toISOString() },
          endpoints: [endpoint],
        }) + "\n",
      );
    });
    socket.on("error", () => {});
  }, "control");
  const records = new Map<string, WorkspacePlacementRecord>();
  const runtime = createWorkspaceRuntime({
    workspaceId: "default",
    owner: "identity",
    environments: [
      {
        address: parseSandboxEnvironmentUri("in-process://brain"),
        pool,
        python: harness.python,
        endpointDirectory: control.slice(0, control.lastIndexOf("/")),
      },
    ],
    store: {
      read: async (address) => records.get(address.target),
      write: async (address, record) => {
        records.set(address.target, record);
      },
    },
  });
  t.after(async () => {
    await runtime.close();
    await pool.close().catch(() => {});
    await harness.dispose();
  });
  const address = parseWorkspaceEndpointUri(`workspace://default/endpoints/${endpoint}`);
  return { agent, fence: <T>(operation: () => Promise<T>) => runtime.fenced(address, operation) };
}

const json = (response: ServerResponse, value: unknown) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

test("an engine Host's reported identity fences its lease across agent restart and PID reuse, without /proc", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "oc-identity-report-"));
  const leases = new ThreadIdentityDatabase(directory);
  t.after(() => {
    leases.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const placement = await workspace(t, "pi");
  // The engine Host inside the environment: it attests its own process and reports it.
  const owner = { incarnation: JSON.stringify(["process", "boot-1", 7, "100"]), duringReport: () => {} };
  const { server, port } = await listen((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health")
      return json(response, {
        ok: true,
        protocolVersion: 1,
        pid: 7,
        machineId: "machine",
        engines: ["pi"],
        defaultEngine: "pi",
      });
    if (url.pathname === "/execution-origin") {
      owner.duringReport();
      return json(response, {
        threadId: url.searchParams.get("threadId"),
        pid: FOREIGN_PID,
        incarnation: owner.incarnation,
      });
    }
    response.writeHead(404).end();
  });
  t.after(() => server.close());
  const descriptor = {
    schemaVersion: 1,
    pid: 7,
    machineId: "machine",
    dataDirectory: directory,
    token: "token",
    engines: ["pi"],
    defaultEngine: "pi",
    websocketUrl: `ws://127.0.0.1:${port}/rpc?token=token`,
  };
  const source = Object.assign(async () => descriptor, { fence: placement.fence });
  const host = await attachEngineHost(source, directory, "machine", ["pi"], "pi");

  const first = await host.getExecutionIdentity("pi_thread");
  assert.deepEqual(
    { pid: first.pid, incarnation: first.incarnation },
    { pid: FOREIGN_PID, incarnation: owner.incarnation },
  );
  const store = new ExecutionLeaseStore(leases.database);
  store.capture("pi_thread", "input", { principal: { provider: "fixture", subject: "A" }, ownership: "human" });
  const executionId = store.begin("pi_thread", "input", first.incarnation);
  store.started("pi_thread", "turn", "input", first.incarnation);
  assert.equal(store.resolve({ threadId: "pi_thread", executionId }).status, "active");

  // The workspace agent restarts while the owner answers: the answer belongs to neither incarnation.
  owner.duringReport = () => {
    placement.agent.id = "b".repeat(32);
    owner.incarnation = JSON.stringify(["process", "boot-1", 7, "900"]);
  };
  await assert.rejects(host.getExecutionIdentity("pi_thread"));
  owner.duringReport = () => {};

  // The successor reuses the PID; its own attested incarnation differs, so the old lease never matches it.
  const successor = await host.getExecutionIdentity("pi_thread");
  assert.equal(successor.pid, first.pid);
  assert.notEqual(successor.incarnation, first.incarnation);
  store.started("pi_thread", "turn", "input", successor.incarnation);
  assert.equal(store.resolve({ threadId: "pi_thread", executionId }).status, "unknown");

  // A malformed report is never accepted.
  owner.incarnation = "";
  await assert.rejects(host.getExecutionIdentity("pi_thread"), /Execution process unavailable/u);
});

test("a DSH Host's engine identity is its own report, fenced by the workspace agent", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "oc-identity-dsh-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const placement = await workspace(t, "dsh");
  const engine = {
    pid: FOREIGN_PID as number | null,
    incarnation: JSON.stringify(["process", "boot-1", 9, "200"]) as string | null,
  };
  let duringHealth = () => {};
  const { server, port } = await listen((request, response) => {
    if (request.url !== "/health") return void response.writeHead(404).end();
    duringHealth();
    json(response, {
      ok: true,
      engine: "dsh",
      pid: 9,
      enginePid: engine.pid,
      engineIncarnation: engine.incarnation,
      hostInputs: 1,
    });
  });
  t.after(() => server.close());
  const descriptor = {
    schemaVersion: 1,
    pid: 9,
    machineId: "machine",
    dataDirectory: directory,
    websocketUrl: `ws://127.0.0.1:${port}/rpc?token=token`,
  };
  const dsh = await attachDshHost(
    Object.assign(async () => descriptor, { fence: placement.fence }),
    directory,
    "machine",
  );
  assert.deepEqual(await dsh.engineExecutionIdentity(), { pid: FOREIGN_PID, incarnation: engine.incarnation });
  duringHealth = () => {
    placement.agent.id = "c".repeat(32);
  };
  await assert.rejects(dsh.engineExecutionIdentity());
  duringHealth = () => {};
  // No engine, or an older Host that reports no incarnation: unknown, never a local guess.
  engine.incarnation = null;
  assert.equal(await dsh.engineExecutionIdentity(), null);
  engine.pid = null;
  assert.equal(await dsh.engineExecutionIdentity(), null);
});
