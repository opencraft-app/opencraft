// The production WorkspaceHost Durable Object (apps/headless-server/src/cloudflare/workspace-host.ts)
// in workerd over an in-isolate container double (workspace-container-double.ts):
// the Host SQL migrated as one database of migration families; the container
// started only through the `cloudflare` sandbox provider (pool admission, custom
// instance, incarnation label, workspace identity in its start environment);
// Host inputs through the workspace-host module to the container's Engine Host
// over its endpoint; idle sleep on the object's alarm; a crash recovered from
// Host state with a system continuation and never a replay; execution reports
// fenced by the agent incarnation; credential leases per incarnation; eviction
// re-attaching the same container; the entry Worker's administrator gate.
// Shared by the Miniflare test (tests/storage/workspace-host-do-workerd.test.ts).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { CODEX_THREAD_START_PATH, CODEX_THREAD_START_AUTHORITY_PATH } from "../../../apps/headless-server/src/cloudflare/codex-thread-start.ts";
import { CODEX_THREAD_LOOKUP_PATH } from "../../../apps/headless-server/src/cloudflare/codex-thread-read.ts";
import { codexActorWorkspace } from "../../../apps/headless-server/src/cloudflare/codex-workspace.ts";
import { APP_HOST_CLIENT_INSTANCE_PARAMETER } from "@opencraft/app-host-protocol/routing";
import { APP_HOST_IDLE_PROBE_ID } from "@opencraft/app-host-protocol";
import { THREAD_PLACEMENT_LOOKUP_PATH } from "../../../apps/headless-server/src/cloudflare/thread-placement.ts";
import { PROOF as LOGIN_PROOF, login, type Backend, type Browser } from "./installation-core-do.scenarios.ts";
import { RECOVERY_PROMPT } from "@opencraft/host-recovery";
import { OPENCRAFT_TERMINAL_EXTENSION, SHARED_INTERACTIONS_CHANGED, SHARED_INTERACTIONS_EXTENSION, SHARED_INTERACTIONS_READ, SHARED_INTERACTIONS_RESPOND, type SharedInteraction } from "@opencraft/appserver-protocol";
import { OPENCRAFT_THREAD_LIFECYCLE_EXTENSION, SIDE_CHAT_INSTRUCTIONS, WORKSPACE_FILE_SCOPE_METHOD, WORKSPACE_PLACEMENT_EXTENSION } from "@opencraft/appserver-protocol";
import { until, type TestWebSocket, type WorkerInstance, type WorkerScenario, type WorkerSpec } from "../../cloudflare/worker-runtime.ts";

import { connectCodex, frameQueue } from "../../cloudflare/codex-apphost-client.ts";

export const WORKSPACE_HOST_DO_SPEC: WorkerSpec = {
  id: "workspace-host-do",
  entry: resolve(import.meta.dirname, "workspace-host-do-worker.ts"),
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: {
    INSTALLATION_CORE: "InstallationCore", WORKSPACE_HOST: "TestWorkspaceHost", CLIENT: "ClientDO", ACCOUNT_CORE: "TestAccountCore",
  },
  externalNode: true,
};

const LOCAL_ORIGIN = "http://127.0.0.1:8787";
const PROOF = "W".repeat(43);
const MACHINE = "2b3148e1-51e3-46a8-af24-cc7bfa3b44cc";
/** Short enough for a test; the production default is 15 minutes. */
const IDLE_MS = 600;
const vars =
  (idle = String(IDLE_MS)) =>
  (origin: string) => ({
    OPENCRAFT_HUMAN_AUTH: JSON.stringify({ origin, local: true, oidc: [] }),
    OPENCRAFT_SETUP_TOKEN: PROOF,
    OPENCRAFT_WORKSPACE_IDLE: idle,
  });

interface State {
  terminalEventUpgrades: number;
  container: {
    running: boolean;
    agent: string | null;
    starts: { instance: unknown; enableInternet: boolean; labels: string[]; env: Record<string, string> }[];
    destroys: number;
    timeouts: number[];
    modelIntercepts: { host: string; running: boolean }[];
    inputs: { agent: string; threadId: string; inputId: string; text: string; turnId: string }[];
    served: string[];
  };
  families: Record<string, { version: number; name: string }[]>;
  tables: string[];
  bridgeCursor: number | null;
  bridgeArchive: { seq: number; payload: string }[];
  alarm: number | null;
  leases: Record<string, any>[];
  unsettled: string[] | null;
  recovery: { state: string; attempts: number; turnId: string; inputId: string | null } | null;
}

function client(instance: WorkerInstance, workspace: string) {
  const call = async (path: string, init?: RequestInit) => {
    const response = await instance.fetch(instance.origin + path, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return {
    owner: (operation: string, body?: unknown, search = "") =>
      call(
        `/__owner/${workspace}/${operation}${search}`,
        body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) },
      ),
    open: () =>
      call(`/__owner/${workspace}/open`, { method: "POST", body: JSON.stringify({ workspace, machine: MACHINE }) }),
    state: async (threadId?: string) =>
      (await call(`/__test/${workspace}/state${threadId ? `?threadId=${threadId}` : ""}`)).body as State,
    test: (operation: string, search = "") => call(`/__test/${workspace}/${operation}${search}`),
    evict: () => instance.fetch(`${instance.origin}/__test/${workspace}/evict`).catch(() => undefined),
  };
}
let sequence = 0;
const workspaceId = () => `ws-${Date.now().toString(36)}-${++sequence}`;

export const WORKSPACE_HOST_DO_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "WorkspaceHost wakes the packaged Bridge and commits its fenced inbox before acknowledging over the private endpoint",
    async run({ runtime }) {
      const workspace = workspaceId();
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: origin => ({
          ...vars("resident")(origin),
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi",
          OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT: "true",
          OPENCRAFT_WORKSPACE_CODEX_SNAPSHOTS: "true",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN: "http://workspace-model.invalid",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER: "openai",
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      try {
        const host = client(instance, workspace);
        assert.equal((await host.open()).status, 200);
        assert.equal((await host.state()).container.starts.length, 0);
        const awake = await host.owner("wake", {});
        assert.equal(awake.status, 200, JSON.stringify(awake.body));
        const { container } = await host.state();
        assert.equal(container.starts.length, 1);
        assert.equal(container.starts[0]?.env.OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT, "true");
        assert.ok(container.served.includes("bridge GET /health"));
        assert.deepEqual(container.served.filter((entry: string) => entry.startsWith("bridge ")),
          ["bridge GET /health", "bridge GET /events", "bridge POST /ack"]);
        assert.equal((await host.state()).bridgeCursor, 1);
        await host.evict();
        assert.equal((await host.owner("wake", {})).status, 200, "the restored owner reads from its committed cursor after producer retention");
        assert.equal((await host.state()).bridgeCursor, 1);
        assert.doesNotMatch(JSON.stringify(awake.body), /"token"/u);

        assert.equal((await host.owner("sleep", {})).status, 200);
        assert.equal((await host.owner("wake", {})).status, 200);
        await host.test("publish-bridge-title", "?title=after-checkpoint");
        assert.equal((await host.owner("wake", {})).status, 200);
        assert.equal((await host.state()).bridgeCursor, 2);

        await host.test("crash", "?evict=true").catch(() => undefined);
        assert.equal((await host.owner("wake", {})).status, 200, "the verified snapshot can restore an older producer cursor");
        const restored = await host.state();
        assert.equal(restored.bridgeCursor, 1);
        assert.equal(restored.bridgeArchive.length, 1);
        assert.equal(restored.bridgeArchive[0]?.seq, 2);
        assert.match(restored.bridgeArchive[0]!.payload, /after-checkpoint/u);
        await host.test("publish-bridge-title", "?title=after-recovery");
        assert.equal((await host.owner("wake", {})).status, 200);
        assert.equal((await host.state()).bridgeCursor, 2, "the new producer may now use that sequence");
        assert.deepEqual((await host.state()).bridgeArchive, restored.bridgeArchive);
      } finally {
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "AppHost creates a placed Bridge Thread and reads its public identity through the shared adapter",
    async run({ runtime }) {
      const workspace = workspaceId();
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: origin => ({
          ...vars("resident")(origin),
          OPENCRAFT_SETUP_TOKEN: LOGIN_PROOF,
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi",
          OPENCRAFT_WORKSPACE_CODEX_DEFAULT: workspace,
          OPENCRAFT_WORKSPACE_CODEX_TURNS: "true",
          OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT: "true",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN: "http://workspace-model.invalid",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER: "openai",
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      const sockets: TestWebSocket[] = [];
      try {
        const { owner } = await login({
          origin: instance.origin,
          fetch: (path, init) => instance.fetch(instance.origin + path, init),
          restart: async () => { throw Error("Use WorkspaceHost eviction"); },
          close: () => runtime.stop(instance),
        });
        const { rpc } = await connectCodex(runtime, instance, owner, sockets, "ready");
        const created = await rpc("thread/start", { ephemeral: false, historyMode: "paginated" });
        assert.ok(created.result, JSON.stringify(created.error));
        const threadId = created.result.thread.id;
        assert.match(threadId, /^bridge:codex:/u);
        const read = await rpc("thread/read", { threadId, includeTurns: false });
        assert.equal(read.result?.thread.id, threadId, JSON.stringify(read.error));
        const state = await client(instance, workspace).state();
        assert.ok(state.container.served.includes("bridge POST /command"));
        assert.ok(!state.container.served.includes("rpc thread/start"));
      } finally {
        for (const socket of sockets) socket.close(1000);
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "a bound workspace migrates its Host SQL as families, starts its container only through the sandbox provider and serves Host inputs through the module",
    async run({ runtime }) {
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, { vars: vars(), localOrigin: LOCAL_ORIGIN });
      try {
        const workspace = workspaceId().padEnd(63, "a");
        const ws = client(instance, workspace);
        // Unbound: nothing migrated, nothing started.
        assert.equal((await ws.owner("open", { workspace, machine: "terminal-owner-rehearsal" })).status, 400);
        assert.deepEqual((await ws.owner("status", undefined)).body, { state: "unbound" });
        let state = await ws.state();
        assert.deepEqual(state.families, {});
        assert.deepEqual(state.tables, []);
        assert.equal(state.container.starts.length, 0);
        const opened = await ws.open();
        assert.equal(opened.status, 200, JSON.stringify(opened.body));
        assert.equal(opened.body.state, "open");
        assert.equal(opened.body.environment.bound, false, "opening starts no container");
        state = await ws.state();
        assert.deepEqual(Object.fromEntries(Object.entries(state.families).map(([id, rows]) => [id, rows.length])), {
          "employee-git-vault-store": 1,
          "host-recovery": 1,
          "host-schedules": 1,
          "opencraft-host-state-database": 17,
          "provider-retry": 1,
          "provisional-threads": 3,
          "workspace-bridge-inbox": 2,
        });
        for (const table of ["execution_leases", "interrupted_turns", "opencraft_thread_catalog", "thread_creations"])
          assert.ok(state.tables.includes(table), table);
        assert.ok(!state.tables.includes("schema_migrations"), "no single-chain ledger");
        assert.equal(state.container.starts.length, 0);
        assert.equal((await ws.owner("codex-health")).status, 404);
        assert.equal((await ws.state()).container.starts.length, 0);
        // Rebinding the same workspace is a no-op; another identity is refused.
        assert.equal((await ws.open()).status, 200);
        assert.equal(
          (
            await instance.fetch(`${instance.origin}/__owner/${workspace}/open`, {
              method: "POST",
              body: JSON.stringify({ workspace, machine: crypto.randomUUID() }),
            })
          ).status,
          409,
        );
        const legacyWorkspace = workspaceId();
        const legacy = client(instance, legacyWorkspace);
        assert.equal((await legacy.test("legacy-invalid-machine", "?workspace=" + legacyWorkspace)).status, 200);
        await legacy.evict();
        assert.equal((await legacy.owner("status")).status, 503);
        assert.equal((await legacy.owner("wake", {})).status, 503);
        assert.equal((await legacy.state()).container.starts.length, 0, "invalid stored identity cannot start a container");

        // A Host input: module → routed conversation execution → Engine Host over the endpoint.
        const submitted = await ws.owner("inputs", { threadId: "pi_thread", id: "first", text: "hello" });
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        assert.equal(submitted.body.receipt.state, "delivered");
        state = await ws.state("pi_thread");
        assert.equal(state.container.starts.length, 1);
        const start = state.container.starts[0]!;
        assert.deepEqual(start.instance, { vcpu: 4, memoryMib: 8192, diskMb: 20000 });
        assert.equal(start.enableInternet, false);
        assert.deepEqual(start.labels, ["oc-incarnation"]);
        assert.deepEqual(start.env, { OPENCRAFT_WORKSPACE_ID: workspace, OPENCRAFT_MACHINE_ID: MACHINE });
        assert.deepEqual(
          state.container.inputs.map(({ threadId, inputId, text }) => ({ threadId, inputId, text })),
          [{ threadId: "pi_thread", inputId: "actor-input:first", text: "hello" }],
        );
        assert.ok(state.container.served.includes("GET /health"));
        assert.ok(state.container.served.includes("POST /host-inputs"));
        assert.deepEqual(state.unsettled, ["pi_thread"], "the module recorded the execution lease");
        assert.equal(state.recovery?.state, "running");
        // The reported native process, fenced by the agent incarnation.
        const native = await ws.owner("execution", undefined, "?threadId=pi_thread");
        assert.deepEqual(native.body, { native: { pid: 42, incarnation: `process:${state.container.agent}` } });
        // Credential lease custody: one lease per engine for this incarnation.
        assert.deepEqual(state.leases.at(-1), {
          grant: { workspace, engine: "pi", incarnation: state.container.agent },
          ttlMs: 600_000,
        });
        const status = (await ws.owner("status", undefined)).body;
        assert.equal(status.environment.bound, true);
        assert.equal(status.environment.epoch, 1);
        assert.deepEqual(status.leases, ["pi"]);
      } finally {
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "a resident workspace routes the private Codex owner lane and keeps it out of public routing",
    async run({ runtime }) {
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: (origin) => ({
          ...vars("resident")(origin),
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN: "http://workspace-model.invalid",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER: "configured/responses",
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      try {
        const workspace = workspaceId();
        const ws = client(instance, workspace);
        assert.equal((await ws.open()).status, 200);
        for (const path of [
          `/__opencraft_workspaces/${workspace}/codex-native`,
          "/__workspace_host/codex-health",
        ]) {
          assert.equal((await instance.fetch(instance.origin + path)).status, 404);
        }
        assert.equal((await ws.owner("codex-native", undefined, "?lane=host-runtime")).status, 426);
        const refused = await instance.upgrade(
          `${instance.origin}/__owner/${workspace}/codex-native?lane=first&lane=second`,
        );
        assert.equal(refused.status, 400);
        assert.equal((await ws.state()).container.starts.length, 0);

        const health = await ws.owner("codex-health");
        assert.equal(health.status, 200);
        const state = await ws.state();
        assert.deepEqual(state.container.starts[0]?.env, {
          OPENCRAFT_WORKSPACE_ID: workspace,
          OPENCRAFT_MACHINE_ID: MACHINE,
          OPENCRAFT_CODEX_EGRESS_ORIGIN: "http://workspace-model.invalid",
          OPENCRAFT_CODEX_EGRESS_PROVIDER: "configured/responses",
        });
        assert.deepEqual(health.body, {
          pid: 41,
          incarnation: `codex-process:${state.container.agent}`,
          callbackIncarnation: `codex-callback:${state.container.agent}`,
          supportsThreadTitle: true,
        });
        const upgrade = await instance.upgrade(
          `${instance.origin}/__owner/${workspace}/codex-native?lane=host-runtime`,
        );
        assert.equal(upgrade.status, 101, upgrade.text);
        const socket = upgrade.socket!;
        try {
          const messages: unknown[] = [];
          socket.addEventListener("message", ({ data }) => messages.push(JSON.parse(String(data))));
          socket.send(JSON.stringify({ id: "init", method: "initialize", params: {} }));
          await until(runtime, () => messages.length, (count) => count > 0, 3000);
          assert.deepEqual(messages, [{ id: "init", result: { userAgent: "codex-double" } }]);
          const submitted = await ws.owner("inputs", { threadId: "pi_parallel", id: "one", text: "work" });
          assert.equal(submitted.body.receipt.state, "delivered");
          const running = await ws.state();
          assert.deepEqual(running.container.timeouts, []);
          assert.ok(running.container.served.includes("codex lane host-runtime"));
          assert.equal((await ws.owner("sleep", {})).status, 409);
          assert.equal(running.container.running, true);
          const closes: number[] = [];
          socket.addEventListener("close", ({ code }) => closes.push(code));
          await ws.test("crash");
          await until(runtime, () => closes.length, (count) => count > 0, 3000);
          assert.deepEqual(closes, [1012]);
        } finally {
          socket.close(1000);
        }
      } finally {
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "native Codex creation commits placement to its workspace and only current Thread and Space members can resolve it",
    async run({ runtime }) {
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: (origin) => ({
          ...vars("resident")(origin),
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi",
          OPENCRAFT_SETUP_TOKEN: LOGIN_PROOF,
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      try {
        const backend: Backend = {
          origin: instance.origin,
          fetch: (path, init) => instance.fetch(instance.origin + path, init),
          restart: async () => { throw new Error("Use object eviction in this scenario"); },
          close: () => runtime.stop(instance),
        };
        const { owner, member } = await login(backend);
        const admission = async (browser: Browser) => {
          const response = await browser.call(
            `/__installation/admission?${APP_HOST_CLIENT_INSTANCE_PARAMETER}=placement-session`,
            undefined,
            { origin: instance.origin },
          );
          assert.equal(response.status, 200, await response.clone().text());
          return response.json();
        };
        const ownerAttachment = await admission(owner);
        const memberAttachment = await admission(member);
        const workspace = workspaceId();
        const ws = client(instance, workspace);
        const other = client(instance, workspaceId());
        assert.equal((await ws.open()).status, 200);
        assert.equal((await other.open()).status, 200);

        const upgrade = await instance.upgrade(`${instance.origin}/__owner/${workspace}/codex-native?lane=placement`);
        assert.equal(upgrade.status, 101, upgrade.text);
        const socket = upgrade.socket!;
        const serverId = `server:${MACHINE}:codex`;
        let thread: { serverId: string; threadId: string };
        try {
          type Reply = { id?: number; method?: string; error?: unknown; result?: { thread: { id: string } } };
          const messages: Reply[] = [];
          socket.addEventListener("message", ({ data }) => messages.push(JSON.parse(String(data)) as Reply));
          let sequence = 0;
          const rpc = async (method: string, params: unknown = {}) => {
            const id = ++sequence;
            socket.send(JSON.stringify({ id, method, params }));
            const read = () => messages.find((message) => message.id === id);
            await until(runtime, read, (reply) => reply !== undefined, 3000);
            return read()!;
          };
          await rpc("initialize");
          const created = (await rpc("thread/start")).result!.thread;
          thread = { serverId, threadId: created.id };
          assert.deepEqual((await ws.owner("thread-placement", thread)).body, {
            ...thread, workspaceId: workspace, revision: 1, state: "placed",
          }, "the receipt is available as soon as the creation success is sent");
          assert.deepEqual(messages.slice(1, 3).map((frame) => frame.method ?? frame.id), ["thread/started", 2]);
          const forked = (await rpc("thread/fork", { threadId: created.id })).result!.thread;
          assert.equal((await ws.owner("thread-placement", { serverId, threadId: forked.id })).status, 200);
          assert.ok((await rpc("thread/start", { fail: true })).error);
          const ephemeral = (await rpc("thread/start", { ephemeral: true })).result!.thread;
          const deferred = (await rpc("thread/start", { __opencraftDeferPublication: true })).result!.thread;
          const read = (await rpc("thread/read", { threadId: "unowned-thread" })).result!.thread;
          for (const { id } of [ephemeral, deferred, read])
            assert.equal((await ws.owner("thread-placement", { serverId, threadId: id })).status, 404);
        } finally {
          socket.close(1000);
        }

        const lookup = (attachment: unknown) => owner.call("/__installation/lookup", { thread, attachment });
        const grant = (assign: boolean) => owner.call("/__installation/assign", { thread, attachment: ownerAttachment, assign });
        const receipt = { ...thread, workspaceId: workspace, revision: 1, state: "placed" };
        assert.equal((await other.owner("thread-placement", thread)).status, 404);
        assert.equal((await owner.call("/__installation/publish", { ...receipt, workspaceId: workspaceId() })).status, 409);
        assert.equal((await owner.call(THREAD_PLACEMENT_LOOKUP_PATH, { thread, attachment: ownerAttachment })).status, 404);
        assert.equal((await lookup(ownerAttachment)).status, 404, "placement alone grants no access");
        assert.equal((await grant(false)).status, 204);
        assert.equal((await lookup(ownerAttachment)).status, 404, "Thread policy alone grants no access");
        assert.equal((await grant(true)).status, 204);
        await until(runtime, async () => (await lookup(ownerAttachment)).status, (status) => status === 200, 3000);
        assert.deepEqual(await (await lookup(ownerAttachment)).json(), receipt);
        assert.equal((await lookup(memberAttachment)).status, 404, "installation membership does not imply Space access");
        assert.equal((await owner.call("/__opencraft_auth/logout", {})).status, 200);
        assert.equal((await lookup(ownerAttachment)).status, 401);

        await ws.evict();
        assert.deepEqual((await ws.owner("thread-placement", thread)).body, receipt);
        assert.equal((await ws.owner("publish-thread-placement", thread)).status, 204);
        assert.equal((await ws.owner("publish-thread-placement", thread)).status, 204);
      } finally {
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "the Client DO reads a Codex Thread over /apphost, fences authorization and reconnects through a fresh lease",
    async run({ runtime }) {
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: (origin) => ({
          ...vars("resident")(origin),
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi",
          OPENCRAFT_SETUP_TOKEN: LOGIN_PROOF,
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      const sockets: NonNullable<Awaited<ReturnType<WorkerInstance["upgrade"]>>["socket"]>[] = [];
      try {
        const backend: Backend = {
          origin: instance.origin,
          fetch: (path, init) => instance.fetch(instance.origin + path, init),
          restart: async () => { throw new Error("This scenario reconnects the socket"); },
          close: () => runtime.stop(instance),
        };
        const { owner, member } = await login(backend);
        const workspace = workspaceId();
        const ws = client(instance, workspace);
        const serverId = await (await owner.call("/__installation/codex-server")).json() as string;
        const machine = serverId.slice("server:".length, -":codex".length);
        const bound = await backend.fetch(`/__owner/${workspace}/open`, {
          method: "POST",
          body: JSON.stringify({ workspace, machine }),
        });
        assert.equal(bound.status, 200, await bound.clone().text());

        const socketUrl = `${instance.origin}/apphost?${APP_HOST_CLIENT_INSTANCE_PARAMETER}=workspace-codex-reader`;
        const privateNative = await instance.upgrade(`${instance.origin}/__owner/${workspace}/codex-native?lane=seed`);
        assert.equal(privateNative.status, 101, privateNative.text);
        const native = privateNative.socket!;
        sockets.push(native);
        const takeNative = frameQueue(runtime, native);
        native.send(JSON.stringify({ id: "seed", method: "initialize", params: {} }));
        await takeNative((frame) => frame.id === "seed");
        native.send(JSON.stringify({ id: "created", method: "thread/start", params: {} }));
        const created = await takeNative((frame) => frame.id === "created");
        const thread = { serverId, threadId: created.result.thread.id as string };
        const receipt = (await ws.owner("thread-placement", thread)).body;
        native.close(1000);
        assert.equal((await ws.owner("publish-thread-placement", thread)).status, 204);

        const attachmentResponse = await owner.call(
          `/__installation/admission?${APP_HOST_CLIENT_INSTANCE_PARAMETER}=workspace-codex-reader`,
          undefined,
          { origin: instance.origin },
        );
        assert.equal(attachmentResponse.status, 200);
        const attachment = await attachmentResponse.json();
        assert.equal((await owner.call("/__installation/assign", { thread, attachment, assign: true })).status, 204);
        assert.equal((await owner.call(CODEX_THREAD_LOOKUP_PATH, { threadId: thread.threadId, attachment })).status, 404);
        assert.equal((await owner.call("/__workspace_host/codex-thread-read", { thread, attachment })).status, 404);
        assert.equal((await ws.owner("codex-thread-read", {
          placement: { ...receipt, revision: receipt.revision + 1 },
          attachment,
          read: { threadId: thread.threadId },
        })).status, 404, "the WorkspaceHost independently rejects a forged revision");
        assert.equal((await instance.upgrade(socketUrl, { origin: instance.origin })).status, 401);

        const connect = (browser: Browser) => connectCodex(runtime, instance, browser, sockets);

        const read = { threadId: thread.threadId, includeTurns: true };
        const authorized = await connect(owner);
        assert.equal((await authorized.rpc("thread/read", read)).result.thread.id, thread.threadId);
        const readConnection = (await ws.state()).container.served;
        assert.ok(readConnection.includes("codex one-shot connection"));
        assert.equal(readConnection.some(value => value.startsWith("codex lane workspace-rpc:")), false);
        const readCount = async () => (await ws.state()).container.served.filter((value) => value === "rpc thread/read").length;
        const count = await readCount();
        const unauthorized = await connect(member);
        assert.equal((await unauthorized.rpc("thread/read", read)).error.code, -32004);
        assert.equal((await authorized.rpc("thread/read", { ...read, workspaceId: workspace })).error.code, -32602);
        assert.equal((await authorized.rpc("turn/start", read)).error.code, -32601);
        assert.equal(await readCount(), count);
        assert.ok(!(await ws.state()).container.served.includes("rpc turn/start"));

        const retired: number[] = [];
        authorized.socket.addEventListener("close", ({ code }) => retired.push(code));
        const reconnected = await connect(owner);
        await until(runtime, () => retired[0], (code) => code === 1012, 3000);
        assert.equal((await reconnected.rpc("thread/read", read)).result.thread.id, thread.threadId);

        await ws.test("pause-codex-reads");
        const inFlight = reconnected.rpc("thread/read", read);
        await until(runtime, readCount, (value) => value === count + 2, 3000);
        assert.equal((await owner.call("/__opencraft_auth/logout", {})).status, 200);
        await ws.test("release-codex-reads");
        assert.equal((await inFlight).error.code, -32004, "a read pending during logout releases no history");
      } finally {
        for (const socket of sockets) {
          try { socket.close(1000); } catch { /* The server already retired the socket. */ }
        }
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "the Client DO starts a protected Codex Thread in the default workspace without replaying native creation",
    async run({ runtime }) {
      const workspace = workspaceId();
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: (origin) => ({
          ...vars("resident")(origin),
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi",
          OPENCRAFT_SETUP_TOKEN: LOGIN_PROOF,
          OPENCRAFT_WORKSPACE_CODEX_DEFAULT: workspace,
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      const sockets: TestWebSocket[] = [];
      try {
        const backend: Backend = {
          origin: instance.origin,
          fetch: (path, init) => instance.fetch(instance.origin + path, init),
          restart: async () => { throw new Error("This scenario evicts the WorkspaceHost"); },
          close: () => runtime.stop(instance),
        };
        const { owner, member } = await login(backend);
        const ws = client(instance, workspace);
        const connect = (browser: Browser) => connectCodex(runtime, instance, browser, sockets);
        const unauthorized = await connect(member);
        assert.equal((await unauthorized.rpc("thread/start", {})).error.code, -32004);
        assert.deepEqual((await ws.owner("status")).body, { state: "unbound" });
        assert.equal((await owner.call(CODEX_THREAD_START_PATH, {})).status, 404);
        assert.equal((await owner.call(CODEX_THREAD_START_AUTHORITY_PATH, {})).status, 404);
        assert.equal((await owner.call("/__workspace_host/codex-thread-start", {})).status, 404);

        const authorized = await connect(owner);
        assert.ok(authorized.initialized.capabilities.extensions["opencraft/method-access"].methods.includes("thread/start"));
        for (const params of [{ cwd: "/etc" }, { workspaceId: "other" }, { permissions: ":danger-full-access" }, { ephemeral: true }])
          assert.equal((await authorized.rpc("thread/start", params)).error.code, -32602);
        assert.deepEqual((await ws.owner("status")).body, { state: "unbound" });

        const starts = async () => (await ws.state()).container.served.filter((value) => value === "rpc thread/start").length;
        await ws.test("reject-codex-initialize");
        const refused = await authorized.rpc("thread/start", {}, "creation-intent");
        assert.deepEqual(refused.error.data, { notSubmitted: true, forwarded: false });
        assert.equal(await starts(), 0);
        const result = (await authorized.rpc("thread/start", { ephemeral: false }, "creation-intent")).result;
        const threadId = result.thread.id;
        const serverId = await (await owner.call("/__installation/codex-server")).json();
        assert.deepEqual((await ws.owner("thread-placement", { serverId, threadId })).body, {
          serverId, threadId, workspaceId: workspace, revision: 1, state: "placed",
        });
        assert.equal((await authorized.rpc("thread/read", { threadId })).result.thread.id, threadId);
        assert.equal((await unauthorized.rpc("thread/read", { threadId })).error.code, -32004);
        assert.equal(await starts(), 1);

        await ws.evict();
        const reconnected = await connect(owner);
        const repeated = await reconnected.rpc("thread/start", {}, "creation-intent");
        assert.deepEqual(repeated.result, result);
        assert.equal(await starts(), 1, "same request after DO eviction and new browser socket");
        assert.equal((await reconnected.rpc("thread/read", { threadId, includeTurns: true })).result.thread.id, threadId);

        await ws.test("drop-codex-start-reply");
        const uncertain = await reconnected.rpc("thread/start", {}, "uncertain-intent");
        assert.equal(uncertain.error.data.resultUnknown, true);
        assert.equal(await starts(), 2);
        await ws.evict();
        assert.equal((await reconnected.rpc("thread/start", {}, "uncertain-intent")).error.data.resultUnknown, true);
        assert.equal(await starts(), 2, "an unconfirmed native mutation is never replayed");
        assert.equal((await reconnected.rpc("turn/start", { threadId })).error.code, -32601);

        await ws.test("pause-codex-starts");
        const revoked = reconnected.rpc("thread/start", {}, "revoked-intent");
        await until(runtime, starts, (count) => count === 3, 3000);
        assert.equal((await owner.call("/__opencraft_auth/logout", {})).status, 200);
        await ws.test("release-codex-starts");
        assert.equal((await revoked).error.code, -32004, "a late native success cannot establish access after logout");
      } finally {
        for (const socket of sockets) {
          try { socket.close(1000); } catch { /* The server already retired the socket. */ }
        }
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "AppHost terminal admission, archive cleanup and retry use the Actor's workspace without starting cold Hands for the directory",
    async run({ runtime }) {
      const legacy = workspaceId();
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: origin => ({
          ...vars("resident")(origin), OPENCRAFT_SETUP_TOKEN: LOGIN_PROOF,
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi", OPENCRAFT_WORKSPACE_CODEX_TURNS: "true",
          OPENCRAFT_WORKSPACE_CODEX_DEFAULT: legacy, OPENCRAFT_WORKSPACE_CODEX_ISOLATE_ACTORS: "true",
          OPENCRAFT_WORKSPACE_CODEX_FILES: "true",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN: "http://workspace-model.invalid",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER: "openai",
          OPENCRAFT_ACCOUNT_SEALING_KEY: `k1.${"A".repeat(43)}`,
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      const sockets: TestWebSocket[] = [];
      try {
        const { owner, member } = await login({
          origin: instance.origin,
          fetch: (path, init) => instance.fetch(instance.origin + path, init),
          restart: async () => { throw new Error("Unexpected restart"); },
          close: () => runtime.stop(instance),
        });
        const serverId = await (await owner.call("/__installation/codex-server")).json() as string;
        const machine = serverId.slice("server:".length, -":codex".length);
        const { actor } = await (await owner.call("/__opencraft_actors/me")).json() as { actor: { id: string } };
        const workspace = await codexActorWorkspace(machine, actor.id);
        const host = client(instance, workspace);
        let first = await connectCodex(runtime, instance, owner, sockets, "ready");
        assert.equal(first.initialized.capabilities.extensions[OPENCRAFT_TERMINAL_EXTENSION].selection, "per-request");
        assert.equal(first.initialized.capabilities.extensions[OPENCRAFT_TERMINAL_EXTENSION].draftScopeOnThreadStart, true);
        assert.deepEqual(first.initialized.capabilities.extensions[WORKSPACE_PLACEMENT_EXTENSION], { fileScopeVersion: 1 });
        assert.deepEqual((await first.rpc("process/list", {})).result, { processes: [] });
        assert.equal((await host.state()).container.starts.length, 0);
        assert.equal((await host.state()).terminalEventUpgrades, 0, "listing terminals opens no output WebSocket");
        const spawn = { processHandle: "terminal-owner", command: ["/bin/bash"], tty: true,
          streamStdoutStderr: true, outputBytesCap: null, timeoutMs: null, size: { cols: 80, rows: 24 } };
        assert.equal((await first.rpc("process/spawn", { ...spawn, projectId: "absent-project" })).error.code, -32602);
        assert.equal((await first.rpc("process/spawn", { ...spawn, cwd: "/tmp" })).error.code, -32602);
        assert.equal((await host.state()).container.starts.length, 0);
        assert.equal((await first.rpc("process/spawn", spawn)).result.processHandle, spawn.processHandle);
        assert.equal((await host.state()).container.starts.length, 1);
        assert.equal((await host.state()).terminalEventUpgrades, 1, "launch opens the output WebSocket on demand");
        const draftScopeId = "client-new-thread:terminal-test";
        const promoted = { processHandle: "promoted-draft-terminal", resourceOwnerId: draftScopeId };
        assert.equal((await first.rpc("process/spawn", { ...spawn, ...promoted })).result.processHandle, promoted.processHandle);
        const started = await first.rpc("thread/start", { draftScopeId }, "draft-create");
        assert.ok(started.result, JSON.stringify(started.error));
        const threadId = started.result.thread.id as string;
        const fileScope = (await first.rpc(WORKSPACE_FILE_SCOPE_METHOD, { threadId })).result;
        assert.equal(fileScope.kind, "workspace");
        assert.equal(fileScope.threadId, threadId);
        const file = { workspaceThreadId: threadId, path: fileScope.root + "/preview.txt" };
        const saved = await first.rpc("fs/writeFile", { ...file, dataBase64: "Zmlyc3Q=" });
        assert.deepEqual(saved.result, {}, JSON.stringify(saved.error));
        assert.deepEqual((await first.rpc("fs/readFile", file)).result, { dataBase64: "Zmlyc3Q=" });
        assert.equal((await first.rpc("fs/readFile", { ...file, path: fileScope.root + "/../preview.txt" })).error.code, -32602);
        const processHandle = "terminal-thread";
        const scope = { threadId, processHandle };
        assert.equal((await first.rpc("process/spawn", { ...spawn, ...scope })).result.processHandle, processHandle);
        assert.equal((await first.rpc("process/writeStdin", { ...scope, deltaBase64: "Zmlyc3Q=" })).error, undefined);
        assert.equal((await first.event("process/outputDelta", params => params.processHandle === processHandle)).params.sequence, 1);
        first.socket.close(1000);
        first = await connectCodex(runtime, instance, owner, sockets, "ready");
        assert.equal((await first.rpc("thread/start", { draftScopeId }, "draft-create-after-reconnect")).result.thread.id, threadId);
        assert.deepEqual((await first.rpc("process/list", {})).result.processes.map((entry: { processHandle: string }) =>
          entry.processHandle), [spawn.processHandle, promoted.processHandle]);
        assert.equal((await first.rpc("process/attach", { processHandle: promoted.processHandle, afterSequence: 0 })).result.context.resourceOwnerId,
          draftScopeId);
        assert.equal((await first.rpc("process/attach", { processHandle, afterSequence: 0 })).error.code, -32004);
        const attached = (await first.rpc("process/attach", { ...scope, afterSequence: 0 })).result;
        assert.equal(attached.context.threadId, threadId);
        assert.equal(attached.output[0].deltaBase64, "Zmlyc3Q=");
        assert.equal((await first.rpc("process/resizePty", { ...scope, size: { cols: 101, rows: 37 } })).error, undefined);
        const publicUpgrade = await instance.upgrade(`${instance.origin}/__opencraft_workspaces/${workspace}/terminal`);
        assert.notEqual(publicUpgrade.status, 101);
        const second = await connectCodex(runtime, instance, member, sockets, "ready");
        assert.equal((await second.rpc("process/list", {})).error.code, -32000);
        const attachment = async (browser: Browser) => {
          const response = await browser.call(`/__installation/admission?${APP_HOST_CLIENT_INSTANCE_PARAMETER}=workspace-actor-test`,
            undefined, { origin: instance.origin });
          assert.equal(response.status, 200);
          return response.json();
        };
        assert.equal((await owner.call("/__installation/share-default-space", {
          owner: await attachment(owner), member: await attachment(member),
        })).status, 204);
        assert.deepEqual((await second.rpc("process/list", {})).result, { processes: [] });
        assert.equal((await second.rpc("thread/read", { threadId })).result.thread.id, threadId);
        assert.equal((await second.rpc("fs/readFile", file)).error.code, -32004);
        assert.equal((await second.rpc("process/attach", { ...scope, afterSequence: 0 })).error.code, -32004);
        assert.equal((await second.rpc("process/attach", { processHandle: spawn.processHandle, afterSequence: 0 })).error.code, -32004);

        const draft = { processHandle: spawn.processHandle };
        assert.equal((await first.rpc("process/attach", { ...draft, afterSequence: 0 })).result.phase, "running");
        const rows = async () => ((await (await owner.call("/__installation/resource-state")).json()) as {
          rows: { threadId: string; state: string; pending: string[] }[];
        }).rows;
        assert.deepEqual(await rows(), []);
        assert.equal(first.initialized.capabilities.extensions[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION].archiveStateInRead, true);
        assert.equal((await first.rpc("thread/read", { threadId, includeTurns: false })).result.thread.archived, false);
        await host.test("terminal-cleanup?unavailable=true");
        assert.deepEqual((await first.rpc("thread/archive", { threadId })).result, {});
        assert.equal((await first.rpc("thread/read", { threadId, includeTurns: false })).result.thread.archived, true);
        assert.equal((await first.rpc("fs/readFile", file)).error.code, -32004);
        assert.deepEqual((await rows()).map(({ threadId, state, pending }) => ({ threadId, state, pending })),
          [{ threadId, state: "archived", pending: ["terminal"] }]);
        assert.equal((await first.rpc("process/spawn", { ...spawn, threadId, processHandle: "archive-refused" })).error.code, -32004);
        assert.equal((await first.rpc("process/writeStdin", { ...scope, deltaBase64: "c3RhbGU=" })).error.code, -32004);
        assert.equal((await first.rpc("process/writeStdin", { processHandle: promoted.processHandle, deltaBase64: "c3RhbGU=" })).error.code, -32004);
        await owner.call("/__installation/evict").catch(() => undefined);
        assert.equal((await first.rpc("process/attach", { ...scope, afterSequence: 0 })).error.code, -32004);
        assert.equal((await first.rpc("process/attach", { processHandle: promoted.processHandle, afterSequence: 0 })).error.code, -32004);
        assert.deepEqual((await first.rpc("process/list", {})).result.processes.map((entry: { processHandle: string }) =>
          entry.processHandle), [spawn.processHandle]);
        assert.equal((await first.rpc("process/writeStdin", { ...draft, deltaBase64: "ZHJhZnQ=" })).error, undefined);
        assert.equal((await first.event("process/outputDelta", params => params.processHandle === draft.processHandle)).params.deltaBase64,
          "ZHJhZnQ=");
        await host.test("terminal-cleanup?unavailable=false");
        await until(runtime, rows, value => value[0]?.pending.length === 0, 9000);
        assert.equal((await first.event("process/exited", params => params.processHandle === processHandle)).params.exitCode, 0);
        assert.equal((await first.event("process/exited", params => params.processHandle === promoted.processHandle)).params.exitCode, 0);
        assert.equal((await first.rpc("thread/unarchive", { threadId })).result.thread.id, threadId);
        assert.equal((await rows())[0]?.state, "active");
        assert.equal((await first.rpc("thread/read", { threadId, includeTurns: false })).result.thread.archived, false);
        const restored = { threadId, processHandle: "restored-terminal" };
        assert.equal((await first.rpc("process/spawn", { ...spawn, ...restored })).result.processHandle, restored.processHandle);
        assert.equal((await owner.call("/__installation/resource-observation", true)).status, 204);
        assert.equal((await first.rpc("thread/archive", { threadId })).error.code, -32086);
        assert.equal((await rows())[0]?.state, "active");
        assert.equal((await first.rpc("thread/read", { threadId, includeTurns: false })).result.thread.archived, true);
        assert.equal((await first.rpc("process/list", { threadId })).error.code, -32004);
        const archiveSubmissions = async () =>
          (await host.state()).container.served.filter((entry: string) => entry === "rpc thread/archive").length;
        const submitted = await archiveSubmissions();
        assert.equal(submitted, 2);
        await host.evict();
        first = await connectCodex(runtime, instance, owner, sockets, "ready");
        assert.equal((await first.rpc("process/attach", { ...restored, afterSequence: 0 })).error.code, -32004);
        assert.equal((await owner.call("/__installation/resource-observation", false)).status, 204);
        await until(runtime, rows, value => value[0]?.state === "archived" && value[0]?.pending.length === 0, 9000);
        assert.equal(await archiveSubmissions(), submitted, "recovery must not send an archive again");
        assert.equal((await host.state()).container.starts.length, 1);
        assert.deepEqual((await client(instance, legacy).owner("status")).body, { state: "unbound" });
      } finally {
        for (const socket of sockets) {
          try { socket.close(1000); } catch { /* The server may have retired it. */ }
        }
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "Codex Project registration and Thread placement use the Actor's native project and safe Hands directory",
    async run({ runtime }) {
      const legacy = workspaceId();
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: origin => ({
          ...vars("resident")(origin), OPENCRAFT_SETUP_TOKEN: LOGIN_PROOF,
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi", OPENCRAFT_WORKSPACE_CODEX_TURNS: "true",
          OPENCRAFT_WORKSPACE_CODEX_DEFAULT: legacy, OPENCRAFT_WORKSPACE_CODEX_ISOLATE_ACTORS: "true",
          OPENCRAFT_WORKSPACE_CODEX_FILES: "true", OPENCRAFT_WORKSPACE_CODEX_PROJECTS: "true",
          OPENCRAFT_WORKSPACE_CODEX_SNAPSHOTS: "true",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN: "http://workspace-model.invalid",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER: "openai", OPENCRAFT_ACCOUNT_SEALING_KEY: `k1.${"A".repeat(43)}`,
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      const sockets: TestWebSocket[] = [];
      try {
        const { owner, member } = await login({
          origin: instance.origin,
          fetch: (path, init) => instance.fetch(instance.origin + path, init),
          restart: async () => { throw new Error("Unexpected restart"); },
          close: () => runtime.stop(instance),
        });
        const first = await connectCodex(runtime, instance, owner, sockets, "ready");
        const placement = first.initialized.capabilities.extensions[WORKSPACE_PLACEMENT_EXTENSION];
        assert.equal(placement.fileScopeVersion, 1);
        assert.equal(placement.version, undefined);
        const root = placement.projectDirectoryRoot;
        assert.equal(typeof root, "string");
        const serverId = await (await owner.call("/__installation/codex-server")).json() as string;
        const machine = serverId.slice("server:".length, -":codex".length);
        const { actor } = await (await owner.call("/__opencraft_actors/me")).json() as { actor: { id: string } };
        const host = client(instance, await codexActorWorkspace(machine, actor.id));
        const idleFrames = frameQueue(runtime, first.socket);
        first.socket.send("__test_drop_idle_client_memory");
        assert.equal((await idleFrames(() => true)).type, "test/hibernated");
        first.socket.send(JSON.stringify({ type: "connection/probe", requestId: APP_HOST_IDLE_PROBE_ID }));
        const pong = await idleFrames(() => true);
        assert.equal(pong.type, "response");
        assert.equal(pong.requestId, APP_HOST_IDLE_PROBE_ID);
        assert.equal(pong.ok, true);
        // Project admission requires the already initialized lease. A fresh
        // handler must reconstruct it without a second ready or native send.
        assert.deepEqual((await first.rpc("project/list", {})).result, { data: [], nextCursor: null });
        const resumed = await idleFrames(() => true);
        assert.equal(resumed.type, "host/frame");
        assert.equal(JSON.parse(resumed.frame!).result.nextCursor, null);
        for (const archived of [false, true]) {
          assert.deepEqual((await first.rpc("thread/list", { archived, sortKey: "updated_at" })).result,
            { data: [], nextCursor: null, backwardsCursor: null });
        }
        assert.equal((await host.owner("status")).body.state, "open");
        assert.equal((await host.state()).container.starts.length, 0);
        assert.equal((await first.rpc("fs/readDirectory", { path: root })).result.entries[0].fileName, "demo");
        assert.equal((await host.state()).container.starts.length, 1);
        assert.equal((await first.rpc("fs/readDirectory", { path: "/tmp" })).error.code, -32602);
        assert.equal((await first.rpc("fs/readFile", { path: root + "/file" })).error.code, -32602);
        const cwd = root + "/demo";
        const request = { name: "Native demo", roots: [{ path: cwd }], idempotencyKey: "demo-project" };
        assert.equal((await first.rpc("project/create", { ...request, roots: [{ path: root + "/link" }] })).error.code, -32602);
        const created = await first.rpc("project/create", request);
        assert.ok(created.result, JSON.stringify(created.error));
        const { project } = created.result;
        assert.deepEqual((await first.rpc("project/create", request)).result, { project });
        assert.deepEqual((await first.rpc("project/list", {})).result, { data: [project], nextCursor: null });
        const another = (await first.rpc("project/create", { ...request, name: "Second project", idempotencyKey: "second-project" })).result?.project;
        assert.ok(another);
        assert.equal((await host.owner("sleep", {})).status, 200);
        await host.evict();
        const coldPage = (await first.rpc("project/list", { limit: 1 })).result;
        assert.deepEqual(coldPage?.data, [project]);
        assert.ok(coldPage.nextCursor);
        assert.deepEqual((await first.rpc("project/list", { cursor: coldPage.nextCursor, limit: 1 })).result,
          { data: [another], nextCursor: null });
        assert.equal((await host.state()).container.starts.length, 1, "project browsing after sleep and eviction starts no container");
        const assignment = { projectId: project.id, cwd, runtimeWorkspaceRoots: [cwd] };
        assert.equal((await first.rpc("thread/start", { ...assignment, projectId: "unknown-project" }, "forged-project")).error.message,
          "Selected project unavailable");
        assert.equal((await first.rpc("thread/start", { ...assignment, runtimeWorkspaceRoots: [cwd, root] }, "forged-root")).error.message,
          "Selected project unavailable");
        const started = await first.rpc("thread/start", assignment, "project-thread");
        assert.ok(started.result, JSON.stringify(started.error));
        assert.equal(started.result.thread.projectId, project.id);
        assert.equal(started.result.thread.cwd, cwd);
        assert.equal((await first.rpc("thread/start", assignment, "project-thread")).result.thread.id, started.result.thread.id);
        const terminal = { threadId: started.result.thread.id, projectId: project.id, processHandle: "project-terminal",
          command: ["/bin/bash"], tty: true, streamStdoutStderr: true, outputBytesCap: null, timeoutMs: null, size: { cols: 80, rows: 24 } };
        assert.equal((await first.rpc("process/spawn", { ...terminal, cwd: root })).error.code, -32004);
        const opened = await first.rpc("process/spawn", { ...terminal, cwd });
        assert.equal(opened.result?.processHandle, terminal.processHandle, JSON.stringify(opened.error));
        const scope = { threadId: terminal.threadId, projectId: project.id };
        const write = { ...scope, processHandle: terminal.processHandle, deltaBase64: "cHdkCg==" };
        assert.equal((await first.rpc("process/writeStdin", { ...write, projectId: null })).error.code, -32004);
        assert.deepEqual((await first.rpc("process/writeStdin", write)).result, {});
        assert.equal((await first.event("process/outputDelta", params => params.processHandle === terminal.processHandle)).params.deltaBase64, write.deltaBase64);
        assert.deepEqual((await first.rpc("process/list", scope)).result.processes.map(({ processHandle }: { processHandle: string }) => processHandle),
          [terminal.processHandle]);
        assert.deepEqual((await first.rpc("process/list", { threadId: terminal.threadId })).result, { processes: [] });
        const attach = async (browser: Browser) => (await browser.call(
          `/__installation/admission?${APP_HOST_CLIENT_INSTANCE_PARAMETER}=workspace-project-test`,
          undefined, { origin: instance.origin },
        )).json();
        assert.equal((await owner.call("/__installation/share-default-space", {
          owner: await attach(owner), member: await attach(member),
        })).status, 204);
        const second = await connectCodex(runtime, instance, member, sockets, "ready");
        assert.deepEqual((await second.rpc("project/list", {})).result, { data: [], nextCursor: null });
        assert.equal((await second.rpc("thread/start", assignment, "foreign-project")).error.message, "Selected project unavailable");
      } finally {
        for (const socket of sockets) socket.close(1000);
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "actor-isolated Codex starts and Turns use different containers while shared Thread reads follow placement",
    async run({ runtime }) {
      const legacy = workspaceId();
      const provider = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"type":"response.output_text.delta","delta":"isolated"}\n\n');
      });
      await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
      const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: origin => ({
          ...vars("resident")(origin), OPENCRAFT_SETUP_TOKEN: LOGIN_PROOF,
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi", OPENCRAFT_WORKSPACE_CODEX_TURNS: "true",
          OPENCRAFT_WORKSPACE_CODEX_DEFAULT: legacy, OPENCRAFT_WORKSPACE_CODEX_ISOLATE_ACTORS: "true",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN: "http://workspace-model.invalid",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER: "openai", OPENCRAFT_ACCOUNT_SEALING_KEY: `k1.${"A".repeat(43)}`,
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      const sockets: TestWebSocket[] = [];
      try {
        const { owner, member, memberId } = await login({
          origin: instance.origin,
          fetch: (path, init) => instance.fetch(instance.origin + path, init),
          restart: async () => { throw new Error("This scenario evicts one WorkspaceHost"); },
          close: () => runtime.stop(instance),
        });
        const serverId = await (await owner.call("/__installation/codex-server")).json() as string;
        const machine = serverId.slice("server:".length, -":codex".length);
        const ownerActor = await (await owner.call("/__opencraft_actors/me")).json() as { actor: { id: string } };
        const ownerId = ownerActor.actor.id;
        const [ownerWorkspace, memberWorkspace] = await Promise.all(
          [ownerId, memberId].map(actor => codexActorWorkspace(machine, actor)));
        assert.notEqual(ownerWorkspace, memberWorkspace);
        const configure = async (value: unknown) => {
          const response = await owner.call("/__test/account/op", value);
          assert.equal(response.status, 200, await response.clone().text());
          assert.ok("ok" in await response.json());
        };
        await configure({ op: "config.update", revision: 0, providers: [{ id: "openai", name: "Fixture",
          enabled: true, protocol: "openai-responses", baseUrl, credentialRef: "ACTOR_TEST_KEY", models: [{ id: "m", enabled: true }] }] });
        await configure({ op: "credentials.set", ref: "ACTOR_TEST_KEY", value: "fixture-provider-key" });
        const first = await connectCodex(runtime, instance, owner, sockets, "ready");
        assert.ok((await first.rpc("model/list", {})).result);
        const attachment = async (browser: Browser) => {
          const response = await browser.call(`/__installation/admission?${APP_HOST_CLIENT_INSTANCE_PARAMETER}=workspace-actor-test`,
            undefined, { origin: instance.origin });
          assert.equal(response.status, 200);
          return response.json();
        };
        assert.equal((await owner.call("/__installation/share-default-space", {
          owner: await attachment(owner), member: await attachment(member),
        })).status, 204);
        const second = await connectCodex(runtime, instance, member, sockets, "ready");
        const separate = { historyMode: "paginated", ephemeral: false };
        const firstStart = await first.rpc("thread/start", separate, "new-thread");
        const secondStart = await second.rpc("thread/start", separate, "new-thread");
        assert.ok(firstStart.result, JSON.stringify(firstStart.error));
        assert.ok(secondStart.result, JSON.stringify(secondStart.error));
        const firstId = firstStart.result.thread.id as string, secondId = secondStart.result.thread.id as string;
        const firstHost = client(instance, ownerWorkspace), secondHost = client(instance, memberWorkspace);
        assert.notEqual(firstId, secondId);
        assert.notEqual((await firstHost.state()).container.agent, (await secondHost.state()).container.agent);
        assert.equal((await firstHost.owner("thread-placement", { serverId, threadId: firstId })).body.workspaceId, ownerWorkspace);
        assert.equal((await secondHost.owner("thread-placement", { serverId, threadId: secondId })).body.workspaceId, memberWorkspace);
        assert.equal((await secondHost.owner("thread-placement", { serverId, threadId: firstId })).status, 404);
        assert.deepEqual((await client(instance, legacy).owner("status")).body, { state: "unbound" });
        assert.equal((await firstHost.owner("open", { workspace: ownerWorkspace, machine, ownerActorId: memberId })).status, 400);
        assert.equal((await firstHost.owner("open", { workspace: ownerWorkspace, machine })).status, 400);

        const payload = (threadId: string) => ({ threadId, clientUserMessageId: "isolated-turn",
          input: [{ type: "text", text: "Isolation fixture" }] });
        assert.equal((await second.rpc("turn/start", payload(firstId))).error.code, -32004);
        for (const [session, threadId] of [[first, firstId], [second, secondId]] as const) {
          const turn = await session.rpc("turn/start", payload(threadId));
          assert.ok(turn.result, JSON.stringify(turn.error));
          assert.equal((await session.event("turn/completed")).params.turn.status, "completed");
        }
        await firstHost.evict();
        assert.equal((await second.rpc("thread/read", { threadId: firstId })).result.thread.id, firstId);
        assert.deepEqual((await first.rpc("thread/list", {})).result.data.map((thread: { id: string }) => thread.id), [firstId]);
        assert.deepEqual((await second.rpc("thread/list", {})).result.data.map((thread: { id: string }) => thread.id), [secondId]);
        const fork = await first.rpc("thread/fork", { threadId: firstId, excludeTurns: true });
        assert.ok(fork.result, JSON.stringify(fork.error));
        assert.equal((await firstHost.owner("thread-placement", { serverId, threadId: fork.result.thread.id })).body.workspaceId, ownerWorkspace);
        assert.equal((await firstHost.state()).container.starts.length, 1);
        assert.equal((await secondHost.state()).container.starts.length, 1);

        // Simulate a previously published Thread in the shared workspace.
        const sharedHost = client(instance, legacy);
        assert.equal((await sharedHost.owner("open", { workspace: legacy, machine })).status, 200);
        const seed = await instance.upgrade(`${instance.origin}/__owner/${legacy}/codex-native?lane=legacy-seed`);
        assert.equal(seed.status, 101);
        const native = seed.socket!;
        sockets.push(native);
        const frame = frameQueue(runtime, native);
        native.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
        await frame(value => Number(value.id) === 1);
        native.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
        const legacyId = (await frame(value => Number(value.id) === 2)).result.thread.id;
        native.close(1000);
        const legacyKey = { serverId, threadId: legacyId };
        assert.equal((await sharedHost.owner("publish-thread-placement", legacyKey)).status, 204);
        assert.equal((await owner.call("/__installation/assign", {
          thread: legacyKey, attachment: await attachment(owner), assign: true,
        })).status, 204);
        assert.equal((await first.rpc("thread/read", { threadId: legacyId })).result.thread.id, legacyId);
        const legacyTurn = await first.rpc("turn/start", payload(legacyId));
        assert.ok(legacyTurn.result, JSON.stringify(legacyTurn.error));
        assert.equal((await first.event("turn/completed")).params.turn.status, "completed");
      } finally {
        for (const socket of sockets) {
          try { socket.close(1000); } catch { /* The server may have retired it. */ }
        }
        await runtime.stop(instance);
        provider.closeAllConnections();
        await new Promise<void>(resolve => provider.close(() => resolve()));
      }
    },
  },
  {
    name: "authorized Codex Turns stream, stop on their owning lane, and are never dispatched twice",
    async run({ runtime }) {
      const workspace = workspaceId();
      const providerHits: { authorization?: string; method?: string; path?: string; body: string }[] = [];
      const release = Promise.withResolvers<void>();
      const releaseSecond = Promise.withResolvers<void>();
      const provider = createServer(async (request, response) => {
        const body: Buffer[] = [];
        for await (const chunk of request) body.push(chunk as Buffer);
        providerHits.push({
          authorization: request.headers.authorization,
          method: request.method,
          path: request.url,
          body: Buffer.concat(body).toString(),
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
        await (providerHits.length === 1 ? release.promise : releaseSecond.promise);
        response.end('data: {"type":"response.output_text.delta","delta":"second"}\n\n');
      });
      await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
      const codexIdleMs = 2400;
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: (origin) => ({
          ...vars(String(codexIdleMs))(origin),
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi",
          OPENCRAFT_SETUP_TOKEN: LOGIN_PROOF,
          OPENCRAFT_WORKSPACE_CODEX_DEFAULT: workspace,
          OPENCRAFT_WORKSPACE_CODEX_TURNS: "true",
          OPENCRAFT_WORKSPACE_CODEX_SNAPSHOTS: "true",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN: "http://workspace-model.invalid",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER: "openai",
          OPENCRAFT_ACCOUNT_SEALING_KEY: `k1.${"A".repeat(43)}`,
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      const sockets: TestWebSocket[] = [];
      try {
        const backend: Backend = {
          origin: instance.origin,
          fetch: (path, init) => instance.fetch(instance.origin + path, init),
          restart: async () => { throw new Error("This scenario evicts the WorkspaceHost"); },
          close: () => runtime.stop(instance),
        };
        const { owner, member } = await login(backend);
        const op = async (value: unknown) => {
          const response = await owner.call("/__test/account/op", value);
          assert.equal(response.status, 200, await response.clone().text());
          const state = await response.json();
          assert.ok("ok" in state, JSON.stringify(state));
        };
        const credential = "fixture-provider-key";
        const configuredProvider = {
          id: "openai", name: "Fixture", enabled: true, protocol: "openai-responses", baseUrl,
          credentialRef: "TURN_TEST_KEY", models: [{ id: "m", enabled: true }, { id: "retiring", enabled: true }],
        };
        await op({ op: "config.update", revision: 0, providers: [configuredProvider] });
        await op({ op: "credentials.set", ref: "TURN_TEST_KEY", value: credential });
        let permitted = await connectCodex(runtime, instance, owner, sockets, "ready");
        const unpermitted = await connectCodex(runtime, instance, member, sockets, "ready");
        assert.deepEqual(permitted.initialized.capabilities.extensions["opencraft/thread-start-durability"],
          { version: 1, durableAfter: "first-turn-accepted" });
        assert.equal((await unpermitted.rpc("model/list", {})).error.code, -32004);
        assert.equal((await permitted.rpc("model/list", { workspaceId: "other" })).error.code, -32602);
        const initialCatalog = (await permitted.rpc("model/list", { limit: 1 })).result;
        assert.deepEqual(initialCatalog?.data.map((entry: { model: string }) => entry.model), ["m"]);
        const oldCursor = initialCatalog.nextCursor;
        assert.ok(oldCursor);
        assert.deepEqual((await permitted.rpc("model/list", { cursor: oldCursor })).result?.data.map((entry: { model: string }) => entry.model), ["retiring"]);
        await op({ op: "config.update", revision: 1, providers: [{ ...configuredProvider, name: "Updated fixture",
          models: [{ id: "m", enabled: true }, { id: "retiring", enabled: false }] }] });
        assert.equal((await permitted.rpc("model/list", { cursor: oldCursor })).error.code, -32602);
        const catalogPage = await permitted.rpc("model/list", { limit: 100, includeHidden: false });
        assert.deepEqual(catalogPage.result?.data.map((entry: { model: string }) => entry.model), ["m"], JSON.stringify(catalogPage.error));
        assert.equal(catalogPage.result.data[0].displayName, "Updated fixture · m");
        assert.equal((await client(instance, workspace).state()).container.starts.length, 0, "model discovery leaves a cold workspace stopped");
        assert.equal((await permitted.rpc("model/list", { cursor: "invalid-model-cursor" })).error.code, -32602);
        assert.equal((await permitted.rpc("thread/start", { model: "retiring" })).error.code, -32602);
        assert.equal((await client(instance, workspace).state()).container.starts.length, 0, "a disabled selection is rejected before Linux starts");
        const draftOptions = { model: "m", historyMode: "paginated", collaborationSpaceId: "myself", runtimeWorkspaceRoots: [] };
        const created = await permitted.rpc("thread/start", draftOptions, "create-test-thread");
        assert.ok(created.result, JSON.stringify(created.error));
        const threadId = created.result.thread.id as string;
        assert.equal(created.result.thread.historyMode, "paginated");
        assert.equal(permitted.initialized.capabilities.extensions["opencraft/resume-history"].mode, "paginated");
        assert.equal(permitted.initialized.capabilities.extensions["opencraft/resume-history"].initialReadPage, true);
        assert.equal((await permitted.rpc("thread/start", draftOptions, "create-test-thread")).result.thread.id, threadId);
        assert.equal((await permitted.rpc("thread/start", { ...draftOptions, model: "different" }, "create-test-thread")).error.code, -32086);
        assert.equal((await permitted.rpc("thread/start", { ...draftOptions, historyMode: "legacy" }, "create-test-thread")).error.code, -32086);
        const nativePage = { threadId, limit: 1, itemsView: "full", sortDirection: "desc" };
        assert.deepEqual((await permitted.rpc("thread/turns/list", nativePage)).result,
          { data: [], nextCursor: null, backwardsCursor: null });
        assert.equal((await permitted.rpc("thread/turns/list", { ...nativePage, workspaceId: "other" })).error.code, -32602);
        assert.equal((await unpermitted.rpc("thread/turns/list", nativePage)).error.code, -32004);
        const resume = { threadId, model: null, modelProvider: "opencraft", cwd: "/workspace", history: null, path: null };
        const empty = await permitted.rpc("thread/resume", resume);
        assert.equal(empty.result?.model, "m", JSON.stringify(empty.error));
        assert.deepEqual(empty.result.thread.turns, []);
        assert.equal((await client(instance, workspace).owner("sleep", {})).status, 409, "a Thread without a rollout is still live");
        assert.equal((await permitted.rpc("thread/resume", { ...resume, path: "/other/rollout" })).error.code, -32004);
        assert.equal((await permitted.rpc("thread/resume", { ...resume, history: [] })).error.code, -32602);
        const attachment = async (browser: Browser) => {
          const response = await browser.call(
            `/__installation/admission?${APP_HOST_CLIENT_INSTANCE_PARAMETER}=workspace-codex-reader`,
            undefined,
            { origin: instance.origin },
          );
          assert.equal(response.status, 200);
          return response.json();
        };
        assert.equal((await owner.call("/__installation/share-default-space", {
          owner: await attachment(owner), member: await attachment(member),
        })).status, 204);
        assert.equal((await unpermitted.rpc("thread/read", { threadId })).result.thread.id, threadId);
        assert.equal((await unpermitted.rpc("thread/resume", resume)).error.code, -32004);
        const turn = { threadId, clientUserMessageId: "once", input: [{ type: "text", text: "Hello from AppHost" }], model: "m" };
        assert.equal((await unpermitted.rpc("turn/start", turn)).error.code, -32004);
        assert.equal((await permitted.rpc("turn/start", { ...turn, model: "not-configured" })).error.code, -32602);
        assert.equal((await permitted.rpc("turn/start", { ...turn, cwd: "/etc" })).error.code, -32602);
        assert.equal((await owner.call("/__workspace_host/codex-turn", turn)).status, 404);
        assert.equal((await owner.call("/__opencraft_egress/openai/responses", turn)).status, 404);
        assert.equal((await owner.call("/__opencraft_internal/workspace-codex-catalog?provider=openai")).status, 404);
        assert.equal((await owner.call("/__opencraft_internal/workspace-codex-model-directory?provider=openai", {})).status, 404);
        const ws = client(instance, workspace);
        const catalog = await ws.test("model-catalog");
        assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
        assert.deepEqual(catalog.body.models.map((model: { slug: string }) => model.slug), ["m"]);
        assert.doesNotMatch(JSON.stringify(catalog.body), /fixture-provider-key|TURN_TEST_KEY/);
        assert.equal((await ws.test("model-response")).status, 503);
        assert.equal(providerHits.length, 0);

        const accepted = await permitted.rpc("turn/start", turn);
        assert.equal(accepted.result?.turn?.status, "inProgress", JSON.stringify(accepted.error));
        const id = accepted.result.turn.id;
        assert.equal((await permitted.rpc("thread/archive", { threadId })).error.data.notSubmitted, true);
        assert.equal((await permitted.rpc("thread/name/set", { threadId, name: "still running" })).error.data.notSubmitted, true);
        const commandStart = (await permitted.event("item/started")).params;
        assert.deepEqual(commandStart, {
          threadId, turnId: id, startedAtMs: 1000,
          item: { type: "commandExecution", id: `command:${id}`, command: "printf fixture", cwd: "/workspace",
            source: "agent", status: "inProgress", processId: null, pluginId: null, scriptPath: null,
            commandActions: [{ type: "unknown", command: "printf fixture" }],
            aggregatedOutput: null, exitCode: null, durationMs: null },
        });
        assert.deepEqual((await permitted.event("item/commandExecution/outputDelta")).params,
          { threadId, turnId: id, itemId: commandStart.item.id, delta: "fixture output\n" });
        assert.deepEqual((await permitted.event("item/reasoning/summaryTextDelta")).params,
          { threadId, turnId: id, itemId: "reasoning", delta: "Checking workspace", summaryIndex: 0 });
        assert.deepEqual((await permitted.event("turn/plan/updated")).params,
          { threadId, turnId: id, explanation: null, plan: [{ step: "Check workspace", status: "completed" }] });
        assert.deepEqual((await permitted.event("item/fileChange/patchUpdated")).params,
          { threadId, turnId: id, itemId: "file-change", changes: [{ path: "result.txt", kind: { type: "add" }, diff: "+updated\n" }] });
        const usage = { inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 4,
          reasoningOutputTokens: 0, totalTokens: 12 };
        assert.deepEqual((await permitted.event("thread/tokenUsage/updated")).params,
          { threadId, turnId: id, tokenUsage: { last: usage, total: usage, modelContextWindow: 4096 } });
        const first = await permitted.event("item/agentMessage/delta");
        assert.deepEqual(first.params, { threadId, turnId: id, itemId: "message", delta: "first" });
        assert.equal(providerHits.length, 1);
        const hit = providerHits[0]!;
        assert.deepEqual([hit.method, hit.path, hit.authorization], ["POST", "/v1/responses", `Bearer ${credential}`]);
        assert.deepEqual(JSON.parse(hit.body).input, [{ type: "text", text: "Hello from AppHost", text_elements: [] }]);
        assert.equal((await permitted.rpc("turn/start", turn)).error.data.resultUnknown, true);
        permitted.socket.close(1000);
        permitted = await connectCodex(runtime, instance, owner, sockets, "ready");
        const resumed = await permitted.rpc("thread/resume", resume);
        assert.equal(resumed.result?.thread.turns.find((item: { id: string }) => item.id === id)?.status, "inProgress", JSON.stringify(resumed.error));
        assert.ok(permitted.initialized.capabilities.extensions["opencraft/method-access"].methods.includes("turn/steer"));
        const steer = { threadId, expectedTurnId: id, clientUserMessageId: "steer-once", input: [{ type: "text", text: "One correction" }] };
        assert.equal((await unpermitted.rpc("turn/steer", steer)).error.code, -32004);
        assert.equal((await permitted.rpc("turn/steer", { ...steer, expectedTurnId: "other-turn" })).error.code, -32004);
        assert.equal((await permitted.rpc("turn/steer", { ...steer, cwd: "/etc" })).error.code, -32602);
        assert.deepEqual((await permitted.rpc("turn/steer", steer)).result, { turnId: id });
        const steered = (await permitted.event("item/completed")).params;
        assert.equal(steered.turnId, id);
        assert.deepEqual(steered.item, { type: "userMessage", id: steered.item.id, clientId: steer.clientUserMessageId,
          content: [{ type: "text", text: "One correction", text_elements: [] }] });
        assert.equal((await permitted.rpc("turn/steer", steer)).error.data.resultUnknown, true);
        const unknown = { ...steer, clientUserMessageId: "unknown-steer" };
        assert.equal((await permitted.rpc("turn/steer", unknown)).error.data.resultUnknown, true);
        assert.equal((await permitted.event("item/completed")).params.item.clientId, unknown.clientUserMessageId);
        assert.equal((await permitted.rpc("turn/steer", unknown)).error.data.resultUnknown, true);
        assert.deepEqual((await ws.state()).unsettled, [threadId]);
        assert.equal(providerHits.length, 1);
        assert.equal((await permitted.rpc("thread/fork", { threadId, excludeTurns: true })).error.data.notSubmitted, true);
        assert.equal((await ws.state()).container.served.includes("rpc thread/fork"), false);
        await new Promise((done) => setTimeout(done, codexIdleMs + 300));
        assert.equal((await ws.state()).container.running, true, "active native Turn keeps the container awake");
        release.resolve();
        assert.equal((await permitted.event("item/agentMessage/delta")).params.delta, "second");
        assert.deepEqual((await permitted.event("item/completed")).params, {
          threadId, turnId: id, completedAtMs: 1100,
          item: { ...commandStart.item, status: "completed", aggregatedOutput: "fixture output\n", exitCode: 0, durationMs: 100 },
        });
        assert.equal((await permitted.event("turn/completed")).params.turn.status, "completed");
        const completed = await permitted.rpc("thread/resume", resume);
        assert.equal(completed.result?.thread.turns.find((item: { id: string }) => item.id === id)?.status, "completed", JSON.stringify(completed.error));
        assert.deepEqual(completed.result.thread.turns.find((item: { id: string }) => item.id === id).items
          .map((item: { clientId: string }) => item.clientId), ["once", "steer-once", "unknown-steer"]);
        assert.equal((await permitted.rpc("turn/steer", { ...steer, clientUserMessageId: "late-steer" })).error.code, -32004);
        const state = await ws.state();
        assert.deepEqual(state.unsettled, []);
        assert.deepEqual(state.container.modelIntercepts, [{ host: "workspace-model.invalid", running: false }]);
        assert.equal(state.container.starts[0]?.enableInternet, false);
        const turnPage = await permitted.rpc("thread/turns/list", nativePage);
        assert.equal(turnPage.result?.data[0]?.id, id, JSON.stringify(turnPage.error));
        assert.equal(turnPage.result.data[0].itemsView, "full");
        const mergedRead = { threadId, includeTurns: false,
          initialTurnsPage: { limit: 1, itemsView: "full", sortDirection: "desc" } };
        const merged = await permitted.rpc("thread/read", mergedRead);
        assert.equal(merged.result?.thread.id, threadId, JSON.stringify(merged.error));
        assert.deepEqual(merged.result.initialTurnsPage, turnPage.result);
        assert.equal((await unpermitted.rpc("thread/read", mergedRead)).result.thread.id, threadId);
        assert.equal((await permitted.rpc("thread/read", { ...mergedRead, includeTurns: true })).error.code, -32602);
        const items = await permitted.rpc("thread/items/list", { threadId, turnId: id, limit: 1, sortDirection: "asc" });
        assert.equal(items.result?.data[0]?.item.clientId, "once", JSON.stringify(items.error));
        assert.equal(typeof items.result.nextCursor, "string");
        const olderItems = await permitted.rpc("thread/items/list", { threadId, turnId: id, limit: 1,
          cursor: items.result.nextCursor, sortDirection: "asc" });
        assert.equal(olderItems.result?.data[0]?.item.clientId, "steer-once", JSON.stringify(olderItems.error));
        await ws.test("oversized-next-codex-page");
        assert.equal((await permitted.rpc("thread/turns/list", nativePage)).error.code, -32072);
        await ws.test("oversized-next-codex-page");
        assert.equal((await permitted.rpc("thread/read", mergedRead)).error.code, -32072);
        assert.equal((await permitted.rpc("thread/turns/list", nativePage)).result.data[0].id, id);

        const raw = await instance.upgrade(`${instance.origin}/__owner/${workspace}/codex-native?lane=catalog-fixture`);
        assert.equal(raw.status, 101, raw.text);
        const nativeSocket = raw.socket!;
        sockets.push(nativeSocket);
        const takeNative = frameQueue(runtime, nativeSocket);
        const nativeRpc = async (id: string, method: string, params: object = {}) => {
          nativeSocket.send(JSON.stringify({ id, method, params }));
          return takeNative(frame => frame.id === id);
        };
        await nativeRpc("initialize", "initialize");
        const privateId = (await nativeRpc("private", "thread/start")).result.thread.id;
        const visibleId = (await nativeRpc("visible", "thread/start")).result.thread.id;
        const unplacedId = (await nativeRpc("unplaced", "thread/start", { __opencraftDeferPublication: true })).result.thread.id;
        nativeSocket.close(1000);
        const serverId = await (await owner.call("/__installation/codex-server")).json();
        for (const candidate of [privateId, visibleId]) {
          const key = { serverId, threadId: candidate };
          assert.equal((await ws.owner("publish-thread-placement", key)).status, 204);
          assert.equal((await owner.call("/__installation/assign", {
            thread: key, attachment: await attachment(owner), assign: true, private: candidate === privateId,
          })).status, 204);
        }
        const list = { limit: 1, sortKey: "updated_at", sortDirection: "desc", archived: false };
        const firstPage = await unpermitted.rpc("thread/list", list);
        assert.deepEqual(firstPage.result?.data.map((row: { id: string }) => row.id), [visibleId], JSON.stringify(firstPage.error));
        assert.deepEqual(firstPage.result.data[0].turns, []);
        assert.equal(firstPage.result.data[0].latestTurnCompletion, null);
        assert.ok(firstPage.result.nextCursor);
        assert.doesNotMatch(JSON.stringify(firstPage.result), new RegExp(`${privateId}|${unplacedId}|private-history-payload|after:`, "u"));
        const cursor = firstPage.result.nextCursor;
        const secondPage = await unpermitted.rpc("thread/list", { ...list, cursor });
        assert.deepEqual(secondPage.result?.data.map((row: { id: string }) => row.id), [threadId], JSON.stringify(secondPage.error));
        assert.equal(secondPage.result.nextCursor, null);
        const reverse = await unpermitted.rpc("thread/list", { ...list, sortDirection: "asc", cursor: secondPage.result.backwardsCursor });
        assert.deepEqual(reverse.result?.data.map((row: { id: string }) => row.id), [visibleId], JSON.stringify(reverse.error));
        assert.equal((await permitted.rpc("thread/list", { ...list, cursor })).error.code, -32602);
        assert.equal((await unpermitted.rpc("thread/list", { ...list, cursor, searchTerm: "changed" })).error.code, -32602);
        assert.equal((await unpermitted.rpc("thread/list", { ...list, cursor: cursor + "BAD" })).error.code, -32602);
        assert.deepEqual((await permitted.rpc("thread/list", { ...list, limit: 30 })).result?.data
          .map((row: { id: string }) => row.id), [visibleId, privateId, threadId]);
        assert.equal((await owner.call("/__workspace_host/codex-thread-list", list)).status, 404);

        const threadCatalog = (archived: boolean) => permitted.rpc("thread/list", { ...list, limit: 30, archived });
        assert.deepEqual(permitted.initialized.capabilities.extensions[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION],
          { version: 1, fork: true, rename: true, archive: true, sideChatSettings: true, unsubscribe: true });
        assert.equal((await unpermitted.rpc("thread/name/set", { threadId, name: "not allowed" })).error.code, -32004);
        assert.equal((await unpermitted.rpc("thread/archive", { threadId })).error.code, -32004);
        assert.equal((await permitted.rpc("thread/name/set", { threadId, name: " " })).error.code, -32602);
        assert.equal((await permitted.rpc("thread/archive", { threadId, path: "/etc" })).error.code, -32602);
        assert.deepEqual((await permitted.rpc("thread/name/set", { threadId, name: "Cloud archive fixture" })).result, {});
        assert.equal((await permitted.rpc("thread/read", { threadId })).result.thread.name, "Cloud archive fixture");
        assert.equal((await permitted.rpc("thread/name/set", { threadId, name: "Unconfirmed fixture title" })).error.data.resultUnknown, true);
        assert.equal((await permitted.rpc("thread/read", { threadId })).result.thread.name, "Unconfirmed fixture title");
        assert.deepEqual((await permitted.rpc("thread/archive", { threadId })).result, {});
        assert.equal((await threadCatalog(false)).result.data.some((row: { id: string }) => row.id === threadId), false);
        assert.deepEqual((await threadCatalog(true)).result.data.map((row: { id: string }) => row.id), [threadId]);
        assert.equal((await unpermitted.rpc("thread/unarchive", { threadId })).error.code, -32004);
        assert.equal((await permitted.rpc("thread/unarchive", { threadId })).result.thread.id, threadId);
        assert.deepEqual((await threadCatalog(true)).result.data, []);
        assert.equal((await threadCatalog(false)).result.data.some((row: { id: string }) => row.id === threadId), true);
        assert.deepEqual((await ws.state()).container.served.filter(method => /^rpc thread\/(name\/set|archive|unarchive)$/u.test(method)),
          ["rpc thread/name/set", "rpc thread/name/set", "rpc thread/archive", "rpc thread/unarchive"]);

        assert.ok(permitted.initialized.capabilities.extensions["opencraft/method-access"].methods.includes("turn/interrupt"));
        const running = await permitted.rpc("turn/start", { ...turn, clientUserMessageId: "interrupt-me" });
        assert.ok(running.result, JSON.stringify(running.error));
        const stop = { threadId, turnId: running.result.turn.id };
        assert.equal((await permitted.event("item/agentMessage/delta")).params.turnId, stop.turnId);
        assert.equal((await unpermitted.rpc("turn/interrupt", stop)).error.code, -32004);
        assert.equal((await permitted.rpc("turn/interrupt", { ...stop, turnId: id })).error.code, -32004);
        assert.equal((await permitted.rpc("turn/interrupt", { ...stop, cwd: "/etc" })).error.code, -32602);
        assert.equal((await owner.call("/__workspace_host/codex-turn-control", stop)).status, 404);
        assert.deepEqual((await permitted.rpc("turn/interrupt", stop)).result, {});
        const interrupted = await permitted.event("turn/completed");
        assert.deepEqual([interrupted.params.turn.id, interrupted.params.turn.status], [stop.turnId, "interrupted"]);
        assert.equal((await permitted.rpc("turn/interrupt", stop)).error.code, -32004);
        assert.deepEqual((await ws.state()).unsettled, []);

        assert.equal((await permitted.rpc("turn/start", { ...turn, serviceTier: "priority" })).error.code, -32602);
        const continued = await permitted.rpc("turn/start", { ...turn, clientUserMessageId: "disconnect-me", serviceTier: null });
        assert.ok(continued.result, JSON.stringify(continued.error));
        const continuedId = continued.result.turn.id;
        await permitted.event("item/agentMessage/delta", (params) => params.turnId === continuedId);
        permitted.socket.close(1000);
        const reconnected = await connectCodex(runtime, instance, owner, sockets, "ready");
        const readContinued = async () => {
          const response = await reconnected.rpc("thread/read", { threadId, includeTurns: true });
          return response.result?.thread.turns.find((item: { id: string }) => item.id === continuedId)?.status;
        };
        assert.equal(await readContinued(), "inProgress", "reconnect reads the original active native Turn");
        const activation = await reconnected.rpc("thread/resume", { ...resume, excludeTurns: true });
        assert.deepEqual(activation.result?.thread?.turns, [], JSON.stringify(activation.error));
        assert.deepEqual((await reconnected.rpc("turn/interrupt", { threadId, turnId: continuedId })).result, {});
        assert.equal((await reconnected.event("turn/completed")).params.turn.status, "interrupted");
        await until(runtime, readContinued, (status) => status === "interrupted", 3000);
        assert.deepEqual((await ws.state()).unsettled, []);

        assert.equal(reconnected.initialized.capabilities.extensions[SHARED_INTERACTIONS_EXTENSION].version, 1);
        const awaiting = await reconnected.rpc("turn/start", { threadId, clientUserMessageId: "approve-once",
          input: [{ type: "text", text: "test-native-approval" }] });
        assert.ok(awaiting.result, JSON.stringify(awaiting.error));
        const approvalTurnId = awaiting.result.turn.id;
        const awaitingApproval = (params: { threadId: string; requests?: readonly SharedInteraction[] }) =>
          params.threadId === threadId && params.requests?.some(request =>
            request.params.turnId === approvalTurnId && request.state === "pending") === true;
        const pendingChange = await reconnected.event(SHARED_INTERACTIONS_CHANGED, awaitingApproval);
        const beforeEviction = await reconnected.rpc(SHARED_INTERACTIONS_READ, { threadId });
        assert.equal(beforeEviction.result.requests.length, 1);
        assert.deepEqual(pendingChange.params, beforeEviction.result);
        reconnected.socket.close(1000);
        await ws.evict();
        const approvalClient = await connectCodex(runtime, instance, owner, sockets, "ready");
        const approvalResume = await approvalClient.rpc("thread/resume", resume);
        assert.equal(approvalResume.result?.thread.turns.find((item: { id: string }) => item.id === approvalTurnId)?.status,
          "inProgress", JSON.stringify(approvalResume.error));
        const resumedChange = await approvalClient.event(SHARED_INTERACTIONS_CHANGED, awaitingApproval);
        const approvalList = await approvalClient.rpc(SHARED_INTERACTIONS_READ, { threadId });
        assert.deepEqual(resumedChange.params, approvalList.result);
        assert.equal(approvalList.result.canRespond, true);
        assert.equal(approvalList.result.requests.length, 1);
        const approval = approvalList.result.requests[0];
        assert.equal(approval.id, `human:approval:${approvalTurnId}`);
        assert.equal(approval.id, beforeEviction.result.requests[0].id);
        assert.notEqual(approvalList.result.epoch, beforeEviction.result.epoch);
        assert.equal((await ws.state()).container.starts.length, 1, "approval recovery reattaches the original container");
        assert.equal(approval.params.itemId, "test-approval");
        // Workbench may activate again while a verified subscription still
        // owns delivery. A refused metadata refresh must not detach it.
        const metadataResume = await approvalClient.rpc("thread/resume", { ...resume, excludeTurns: true });
        assert.deepEqual(metadataResume.result?.thread?.turns, [], JSON.stringify(metadataResume.error));
        assert.equal((await approvalClient.rpc("thread/resume", { ...resume, path: "/wrong/rollout" })).error?.code, -32004);
        const detachedReader = await connectCodex(runtime, instance, owner, sockets, "ready", "workspace-codex-detached-reader");
        assert.ok((await detachedReader.rpc("thread/resume", resume)).result);
        assert.deepEqual((await detachedReader.rpc("thread/unsubscribe", { threadId })).result, { status: "unsubscribed" });
        assert.deepEqual((await detachedReader.rpc("thread/unsubscribe", { threadId })).result, { status: "notSubscribed" });
        const reply = { threadId, interactionId: approval.id, submissionId: "fixture-response", result: { decision: "accept" } };
        assert.equal((await unpermitted.rpc(SHARED_INTERACTIONS_RESPOND, reply)).error.code, -32004);
        const answered = await approvalClient.rpc(SHARED_INTERACTIONS_RESPOND, reply);
        assert.ok(answered.result, JSON.stringify(answered.error));
        const cleared = await approvalClient.event(SHARED_INTERACTIONS_CHANGED, (params) =>
          params.threadId === threadId && params.requests?.length === 0);
        assert.equal(cleared.params.epoch, approvalList.result.epoch);
        assert.ok(cleared.params.revision > approvalList.result.revision);
        const approvalCompleted = await approvalClient.event("turn/completed");
        assert.equal(approvalCompleted.params.turn.status, "completed");
        assert.ok(cleared.receivedAt <= approvalCompleted.receivedAt, "Native approval settled after the terminal Turn event");
        assert.deepEqual((await approvalClient.rpc(SHARED_INTERACTIONS_READ, { threadId })).result.requests, []);
        assert.equal((await approvalClient.rpc(SHARED_INTERACTIONS_RESPOND, reply)).result.disposition, "resolved");
        assert.equal((await ws.state()).container.served.filter((value) => value === "native approval reply").length, 1);
        await ws.evict();
        assert.equal((await approvalClient.rpc("turn/start", turn)).error.data.resultUnknown, true);
        assert.equal(providerHits.length, 3);
        assert.deepEqual((await ws.state()).container.served.filter((value) => /^rpc turn\//u.test(value)),
          ["rpc turn/start", "rpc turn/steer", "rpc turn/steer", "rpc turn/start", "rpc turn/interrupt",
            "rpc turn/start", "rpc turn/interrupt", "rpc turn/start"]);
        const originalAgent = (await ws.state()).container.agent;
        await ws.test("reject-next-snapshot");
        assert.equal((await ws.owner("sleep", {})).status, 503, "snapshot failure refuses to retire the container");
        assert.equal((await ws.state()).container.running, true);
        const slept = await ws.owner("sleep", {});
        assert.equal(slept.status, 200, JSON.stringify(slept.body));
        assert.equal((await ws.state()).container.running, false);
        await ws.evict();
        assert.deepEqual((await approvalClient.rpc("model/list", {})).result, catalogPage.result);
        assert.equal((await ws.state()).container.starts.length, 1, "model discovery leaves a sleeping workspace stopped");
        const coldQuery = { limit: 1, archived: false, sortKey: "updated_at", sortDirection: "desc" };
        const coldFirst = (await approvalClient.rpc("thread/list", coldQuery)).result;
        assert.equal(coldFirst?.data.length, 1);
        assert.ok(coldFirst.nextCursor);
        await ws.evict();
        const coldNext = (await approvalClient.rpc("thread/list", { ...coldQuery, cursor: coldFirst.nextCursor })).result;
        assert.equal(coldNext?.data.length, 1);
        assert.notEqual(coldNext.data[0].id, coldFirst.data[0].id);
        const afterEvictionDirectory = await approvalClient.rpc("thread/list", { ...coldQuery, limit: 30 });
        const completion = afterEvictionDirectory.result?.data.find((row: { id: string }) => row.id === threadId)?.latestTurnCompletion;
        assert.equal(completion?.id, approvalTurnId, JSON.stringify(afterEvictionDirectory.error));
        assert.equal(completion.status, "completed");
        assert.equal((await ws.state()).container.starts.length, 1, "thread pagination across DO eviction does not start Linux");
        const afterSleep = await approvalClient.rpc("thread/read", { threadId, includeTurns: true });
        assert.equal(afterSleep.result?.thread.turns.find((turn: { id: string }) => turn.id === approvalTurnId)?.status,
          "completed", JSON.stringify(afterSleep.error));
        const sleeping = await ws.state();
        assert.equal(sleeping.container.running, false, "history reads do not wake Linux");
        assert.equal(sleeping.container.starts.length, 1);
        const page = { limit: 10, itemsView: "full", sortDirection: "desc" };
        const view = await approvalClient.rpc("thread/turns/list", { threadId, ...page });
        assert.equal(view.result?.data.find((turn: { id: string }) => turn.id === approvalTurnId)?.status, "completed");
        const mergedAfterSleep = await approvalClient.rpc("thread/read", { threadId, includeTurns: false, initialTurnsPage: page });
        assert.equal(mergedAfterSleep.result?.thread.id, threadId, JSON.stringify(mergedAfterSleep.error));
        assert.deepEqual(mergedAfterSleep.result.initialTurnsPage, view.result);
        const unavailable = await approvalClient.rpc("thread/turns/list", { ...nativePage, cursor: "unrecorded" });
        assert.equal(unavailable.error.code, -32073);
        assert.equal((await ws.state()).container.starts.length, 1, "a history miss does not start Linux");
        assert.deepEqual(sleeping.container.timeouts, [], "the provider cannot stop a Codex container before its checkpoint");
        assert.equal(providerHits.length, 3, "reading history does not replay input");
        assert.deepEqual((await approvalClient.rpc("thread/name/set", { threadId, name: "Before idle sleep" })).result, {});
        const restored = await ws.state();
        assert.notEqual(restored.container.agent, originalAgent);
        assert.equal(restored.container.starts[1]?.restored, true);
        const armed = (await ws.state()).alarm;
        assert.ok(armed, "Codex idle deadline is armed");
        await new Promise((done) => setTimeout(done, codexIdleMs / 2));
        await ws.evict();
        const afterEviction = (await ws.state()).alarm;
        assert.ok(afterEviction && afterEviction <= armed + codexIdleMs / 10,
          "eviction resumes the persisted idle deadline");
        await until(runtime, () => ws.state(), (state) => !state.container.running, codexIdleMs * 2);
        const afterIdle = await approvalClient.rpc("thread/read", { threadId, includeTurns: true });
        assert.equal(afterIdle.result?.thread.name, "Before idle sleep", JSON.stringify(afterIdle.error));
        assert.equal(afterIdle.result.thread.turns.find((turn: { id: string }) => turn.id === approvalTurnId)?.status, "completed");
        assert.equal((await ws.state()).container.starts.length, 2, "idle history does not start a third container");
        assert.equal(providerHits.length, 3, "idle history does not replay input");
        const forkParams = { threadId, lastTurnId: id, excludeTurns: true };
        assert.equal((await unpermitted.rpc("thread/fork", forkParams)).error.code, -32004);
        assert.equal((await approvalClient.rpc("thread/fork", { ...forkParams, path: "/etc/passwd" })).error.code, -32602);
        assert.equal((await approvalClient.rpc("thread/fork", { ...forkParams, beforeTurnId: id })).error.code, -32602);
        assert.equal((await approvalClient.rpc("thread/fork", { ...forkParams, ephemeral: true })).error.code, -32602);
        assert.equal((await approvalClient.rpc("thread/fork", { threadId: unplacedId, excludeTurns: true })).error.code, -32004);
        assert.equal((await ws.state()).container.served.includes("rpc thread/fork"), false);

        const forked = await approvalClient.rpc("thread/fork", forkParams, "fork-through-first");
        assert.ok(forked.result, JSON.stringify(forked.error));
        const child = forked.result.thread;
        assert.notEqual(child.id, threadId);
        assert.equal(child.forkedFromId, threadId);
        const childPage = await unpermitted.rpc("thread/turns/list", { ...nativePage, threadId: child.id });
        assert.deepEqual(childPage.result?.data.map((turn: { id: string }) => turn.id), [id], JSON.stringify(childPage.error));
        assert.equal(childPage.result.nextCursor, null);
        await ws.evict();
        assert.equal((await approvalClient.rpc("thread/fork", forkParams, "fork-through-first")).result.thread.id, child.id);
        assert.equal((await approvalClient.rpc("thread/fork", { threadId, beforeTurnId: id }, "fork-through-first")).error.code, -32086);
        assert.equal((await unpermitted.rpc("turn/start", { ...turn, threadId: child.id })).error.code, -32004);

        const privateFork = await approvalClient.rpc("thread/fork", { threadId: privateId }, "private-fork");
        assert.ok(privateFork.result, JSON.stringify(privateFork.error));
        assert.equal((await unpermitted.rpc("thread/read", { threadId: privateFork.result.thread.id })).error.code, -32004);
        assert.equal((await unpermitted.rpc("thread/read", { ...mergedRead, threadId: privateFork.result.thread.id })).error.code, -32004);
        assert.equal((await approvalClient.rpc("thread/read", { threadId: privateFork.result.thread.id })).result.thread.id,
          privateFork.result.thread.id);
        await ws.test("drop-codex-start-reply");
        const uncertainFork = await approvalClient.rpc("thread/fork", forkParams, "drop-native-fork-reply");
        assert.equal(uncertainFork.error.data.resultUnknown, true);
        await ws.evict();
        assert.equal((await approvalClient.rpc("thread/fork", forkParams, "drop-native-fork-reply")).error.data.resultUnknown, true);
        assert.equal((await ws.state()).container.served.filter(method => method === "rpc thread/fork").length, 3);

        const sideParams = { threadId, cwd: "/workspace", workspaceFork: { kind: "side-chat", intentId: "side-one" },
          ephemeral: false, excludeTurns: true, deferGoalContinuation: true, developerInstructions: SIDE_CHAT_INSTRUCTIONS };
        assert.equal((await approvalClient.rpc("thread/fork", { ...sideParams, developerInstructions: "arbitrary" })).error.code, -32602);
        assert.equal((await approvalClient.rpc("thread/fork", { ...sideParams, cwd: "/etc" })).error.data.notSubmitted, true);
        // A rejected CWD cannot be reused for a different request under its original intent.
        sideParams.workspaceFork.intentId = "side-two";
        const side = await approvalClient.rpc("thread/fork", sideParams);
        assert.ok(side.result, JSON.stringify(side.error));
        const sideId = side.result.thread.id;
        assert.equal(side.result.thread.forkedFromId, threadId);
        const sideSettings = { collaborationMode: { mode: "default", settings: {
          model: "m", reasoning_effort: null, developer_instructions: SIDE_CHAT_INSTRUCTIONS,
        } } };
        assert.equal((await approvalClient.rpc("thread/settings/update", { ...sideSettings, threadId })).error.code, -32004);
        assert.deepEqual((await approvalClient.rpc("thread/settings/update", { ...sideSettings, threadId: sideId })).result, {});
        await ws.evict();
        const sideReader = await connectCodex(runtime, instance, owner, sockets, "ready");
        const repeated = await sideReader.rpc("thread/fork", sideParams, "different-rpc-id");
        assert.equal(repeated.result?.thread.id, sideId, JSON.stringify(repeated.error));
        assert.equal((await sideReader.rpc("thread/resume", { threadId: sideId, excludeTurns: true })).result?.thread.id, sideId);
        const sideTurn = await sideReader.rpc("turn/start", { ...turn, threadId: sideId, clientUserMessageId: "side-turn" });
        assert.ok(sideTurn.result, JSON.stringify(sideTurn.error));
        await sideReader.event("item/agentMessage/delta", params => params.threadId === sideId && params.delta === "first");
        releaseSecond.resolve();
        const sideCompleted = await sideReader.event("turn/completed", params => params.threadId === sideId);
        assert.equal(sideCompleted.params.turn.status, "completed");
        assert.deepEqual((await sideReader.rpc("thread/unsubscribe", { threadId: sideId })).result, { status: "notSubscribed" });
        assert.equal((await sideReader.rpc("thread/read", { threadId })).result?.thread.id, threadId);
        const ordinaryCatalog = await sideReader.rpc("thread/list", { limit: 20 });
        assert.ok(ordinaryCatalog.result?.data.some((entry: { id: string }) => entry.id === threadId), JSON.stringify(ordinaryCatalog.error));
        assert.ok(!ordinaryCatalog.result.data.some((entry: { id: string }) => entry.id === sideId));
        assert.equal((await ws.owner("sleep", {})).status, 200);
        const beforeSend = (await ws.state()).container.starts.length;
        assert.equal((await ws.state()).container.running, false);
        assert.equal((await sideReader.rpc("thread/turns/list", { ...nativePage, cursor: "unrecorded" })).error.code, -32073);
        assert.equal((await ws.state()).container.starts.length, beforeSend);
        const fresh = await sideReader.rpc("turn/start", { ...turn, clientUserMessageId: "send-after-read-only-sleep" });
        assert.ok(fresh.result, JSON.stringify(fresh.error));
        await sideReader.event("turn/completed", params => params.turn.id === fresh.result.turn.id);
        const afterSend = (await ws.state()).container.starts;
        assert.equal(afterSend.length, beforeSend + 1, "sending wakes Linux once");
        assert.equal(afterSend.at(-1)?.restored, true);

      } finally {
        release.resolve();
        releaseSecond.resolve();
        for (const socket of sockets) {
          try { socket.close(1000); } catch { /* The server already retired it. */ }
        }
        await runtime.stop(instance);
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
      }
    },
  },
  {
    name: "Codex container loss retires the old Turn lease without submitting that input again",
    async run({ runtime }) {
      const workspace = workspaceId();
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: origin => ({
          ...vars("resident")(origin),
          OPENCRAFT_SETUP_TOKEN: LOGIN_PROOF,
          OPENCRAFT_WORKSPACE_ENGINES: "codex,pi",
          OPENCRAFT_WORKSPACE_CODEX_DEFAULT: workspace,
          OPENCRAFT_WORKSPACE_CODEX_TURNS: "true",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN: "http://workspace-model.invalid",
          OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER: "openai",
          OPENCRAFT_ACCOUNT_SEALING_KEY: `k1.${"A".repeat(43)}`,
        }),
        localOrigin: LOCAL_ORIGIN,
      });
      const sockets: TestWebSocket[] = [];
      const ws = client(instance, workspace);
      try {
        const { owner } = await login({
          origin: instance.origin,
          fetch: (path, init) => instance.fetch(instance.origin + path, init),
          restart: async () => { throw new Error("This scenario crashes the container"); },
          close: () => runtime.stop(instance),
        });
        const connect = () => connectCodex(runtime, instance, owner, sockets, "ready");
        let connection = await connect();
        const dispatches = (state: State) => state.container.served.filter(entry => entry === "rpc turn/start").length;
        for (const evict of [false, true]) {
          const created = await connection.rpc("thread/start", { historyMode: "paginated" });
          assert.ok(created.result, JSON.stringify(created.error));
          const threadId = created.result.thread.id;
          const input = { threadId, clientUserMessageId: "lost-turn", input: [{ type: "text", text: "test-native-approval" }] };
          const prior = dispatches(await ws.state());
          if (evict) assert.equal((await ws.test("hold-codex-turn-reply")).status, 200);
          const start = connection.rpc("turn/start", input);
          // In the eviction case the native owner receives the input but the
          // WorkspaceHost never receives the native Turn ID.
          if (evict) void start.catch(() => {});
          else {
            const started = await start;
            assert.ok(started.result, JSON.stringify(started.error));
            await connection.event(SHARED_INTERACTIONS_CHANGED, params => params.threadId === threadId && params.requests.length > 0);
          }
          const before = await until(runtime, () => ws.state(), state => dispatches(state) > prior, 2000);
          assert.deepEqual(before.unsettled, [threadId]);
          assert.equal(dispatches(before), prior + 1);

          await ws.test("crash", evict ? "?evict=true" : "").catch(error => { if (!evict) throw error; });
          const after = await until(runtime, () => ws.state(), state => state.unsettled?.length === 0, 2000);
          assert.equal(after.container.running, false);
          assert.deepEqual(after.unsettled, [], "confirmed container loss frees the execution slot");
          try { connection.socket.close(1000); } catch { /* The Turn stream may have closed the socket. */ }
          if (evict) {
            const unknown = await start.catch(() => null);
            assert.ok(!unknown?.result, "the original native receipt was withheld");
          }
          connection = await connect();
          const duplicate = await connection.rpc("turn/start", input);
          assert.equal(duplicate.error?.data.resultUnknown, true);
          assert.equal(dispatches(await ws.state()), prior + 1);
          const interactions = await connection.rpc(SHARED_INTERACTIONS_READ, { threadId });
          assert.deepEqual(interactions.result?.requests, []);
        }
        const created = await connection.rpc("thread/start", { historyMode: "paginated" });
        assert.ok(created.result, JSON.stringify(created.error));
        const next = await connection.rpc("turn/start", { threadId: created.result.thread.id,
          clientUserMessageId: "new-turn", input: [{ type: "text", text: "test-native-approval" }] });
        assert.ok(next.result, JSON.stringify(next.error));
      } finally {
        for (const socket of sockets) {
          try { socket.close(1000); } catch { /* The Turn stream may have closed the socket. */ }
        }
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "an idle workspace stops its container on the object's alarm once its Turn finished; the backstop is re-armed on every construction",
    async run({ runtime }) {
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, { vars: vars(), localOrigin: LOCAL_ORIGIN });
      try {
        const workspace = workspaceId();
        const ws = client(instance, workspace);
        await ws.open();
        assert.equal((await ws.owner("inputs", { threadId: "pi_idle", id: "one", text: "work" })).status, 200);
        let state = await ws.state();
        assert.equal(state.container.running, true);
        assert.ok(state.alarm !== null, "the idle check is on the object's alarm");
        // A running Turn keeps the workspace awake past the idle time.
        await new Promise((done) => setTimeout(done, IDLE_MS * 2.5));
        state = await ws.state();
        assert.equal(state.container.running, true, "a Turn in progress is not idle");
        // The Turn finishes: the next check settles its lease and stops the container.
        assert.equal((await ws.test("complete")).body, 1);
        state = await until(
          runtime,
          () => ws.state(),
          (value) => !value.container.running,
          IDLE_MS * 6,
        );
        assert.equal(state.container.running, false);
        assert.equal(state.container.destroys, 1);
        assert.deepEqual(state.unsettled, []);
        assert.deepEqual(state.leases.at(-1), { revokeHolder: { workspace } });
        assert.equal((await ws.owner("status")).body.environment.bound, false);
        // Waking is a new incarnation started through the provider.
        const woken = (await ws.owner("wake", {})).body;
        assert.equal(woken.environment.bound, true);
        assert.equal(woken.environment.epoch, 2);
        state = await ws.state();
        assert.equal(state.container.starts.length, 2);
        const timeouts = state.container.timeouts.length;
        // A reset object re-arms the container backstop in its constructor and re-attaches the same container.
        await ws.evict();
        const after = (await ws.owner("status")).body;
        assert.equal(after.state, "open");
        state = await ws.state();
        assert.ok(state.container.timeouts.length > timeouts, "backstop re-armed on construction");
        assert.ok(state.container.timeouts.every((value) => value === IDLE_MS));
        assert.equal((await ws.owner("wake", {})).body.environment.epoch, 2, "the same incarnation re-attached");
        assert.equal((await ws.state()).container.starts.length, 2);
      } finally {
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "a crashed container is recovered from Host state: a new incarnation, a system continuation, no replay",
    async run({ runtime }) {
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: vars("resident"),
        localOrigin: LOCAL_ORIGIN,
      });
      try {
        const workspace = workspaceId();
        const ws = client(instance, workspace);
        await ws.open();
        assert.equal(
          (await ws.owner("inputs", { threadId: "pi_crash", id: "original", text: "original prompt" })).status,
          200,
        );
        const first = (await ws.state("pi_crash")).container.agent;
        await ws.test("crash", "?code=137");
        const state = await until(
          runtime,
          () => ws.state("pi_crash"),
          (value) => value.recovery?.state === "running" && value.recovery.attempts === 1 &&
            value.leases.at(-1)?.grant?.incarnation === value.container.agent,
          5000,
        );
        assert.equal(state.container.starts.length, 2);
        assert.notEqual(state.container.agent, first);
        // The new incarnation received exactly one input: the system continuation, never the original text.
        const second = state.container.inputs.filter((input) => input.agent === state.container.agent);
        assert.equal(second.length, 1);
        assert.equal(second[0]!.text, RECOVERY_PROMPT);
        assert.match(second[0]!.inputId, /^restart-recovery:/u);
        assert.equal(state.container.inputs.filter((input) => input.text === "original prompt").length, 1);
        assert.equal(state.recovery!.turnId, second[0]!.turnId);
        // Leases of the lost incarnation are revoked; the new one holds its own.
        assert.ok(state.leases.some((call) => call.revokeHolder?.workspace === workspace && !call.revokeHolder.engine));
        assert.deepEqual(state.leases.at(-1)?.grant, { workspace, engine: "pi", incarnation: state.container.agent });
        assert.equal((await ws.owner("status")).body.environment.epoch, 2);
      } finally {
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "an execution report is refused when the agent incarnation changes around it, then rebound and recovered",
    async run({ runtime }) {
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, {
        vars: vars("resident"),
        localOrigin: LOCAL_ORIGIN,
      });
      try {
        const ws = client(instance, workspaceId());
        await ws.open();
        await ws.owner("inputs", { threadId: "pi_fence", id: "one", text: "work" });
        const first = (await ws.state()).container.agent;
        // The agent restarts in the same container (no provider loss signal).
        await ws.test("restart-agent");
        const refused = await ws.owner("execution", undefined, "?threadId=pi_fence");
        assert.deepEqual(refused.body, { native: null }, "an unattributable report is no evidence");
        const status = (await ws.owner("status")).body;
        assert.equal(status.environment.bound, false, "the stale binding was released");
        // The next use rebinds the new incarnation and recovers its Turn.
        assert.equal((await ws.owner("wake", {})).body.environment.epoch, 2);
        const state = await until(
          runtime,
          () => ws.state("pi_fence"),
          (value) => value.recovery?.attempts === 1 && value.recovery.state === "running",
          5000,
        );
        assert.notEqual(state.container.agent, first);
        // Releasing the stale binding stopped its container (a Cloudflare environment's close); waking created another.
        assert.equal(state.container.destroys, 1);
        assert.equal(state.container.starts.length, 2);
        assert.equal((await ws.owner("status")).body.environment.epoch, 2);
        const native = await ws.owner("execution", undefined, "?threadId=pi_fence");
        assert.deepEqual(native.body, { native: { pid: 42, incarnation: `process:${state.container.agent}` } });
      } finally {
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "a changed Host ledger keeps the object closed; operator routes need an installation administrator",
    async run({ runtime }) {
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, { vars: vars(), localOrigin: LOCAL_ORIGIN });
      try {
        const workspace = workspaceId();
        const ws = client(instance, workspace);
        await ws.open();
        await ws.test("tamper");
        await ws.evict();
        assert.equal((await ws.owner("status")).status, 503);
        assert.equal((await ws.owner("wake", {})).status, 503);
        // The public operator route: refused without a session, served for an administrator.
        const other = workspaceId();
        await client(instance, other).open();
        const path = `${instance.origin}/__opencraft_workspaces/${other}/status`;
        assert.equal((await instance.fetch(path)).status, 401);
        assert.equal(
          (await instance.fetch(`${instance.origin}/__opencraft_workspaces/${other}/open`, { method: "POST" })).status,
          404,
        );
        const setup = await instance.fetch(`${instance.origin}/__opencraft_account/setup`, {
          method: "POST",
          headers: { origin: instance.origin, "content-type": "application/json" },
          body: JSON.stringify({ proof: PROOF, mode: "web", username: "owner", password: "Fixture-owner-password-42" }),
        });
        assert.equal(setup.status, 200, await setup.clone().text());
        const cookie = setup.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        const served = await instance.fetch(path, { headers: { cookie } });
        assert.equal(served.status, 200, await served.clone().text());
        assert.equal(((await served.json()) as { workspace: string }).workspace, other);
        assert.equal(
          (
            await instance.fetch(`${instance.origin}/__opencraft_workspaces/${other}/status`.replace(other, "Bad_Id"), {
              headers: { cookie },
            })
          ).status,
          404,
        );
      } finally {
        await runtime.stop(instance);
      }
    },
  },
];
