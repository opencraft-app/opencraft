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
import { resolve } from "node:path";
import { RECOVERY_PROMPT } from "@opencraft/host-recovery";
import { until, type WorkerInstance, type WorkerScenario, type WorkerSpec } from "../../cloudflare/worker-runtime.ts";

export const WORKSPACE_HOST_DO_SPEC: WorkerSpec = {
  id: "workspace-host-do",
  entry: resolve(import.meta.dirname, "workspace-host-do-worker.ts"),
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { INSTALLATION_CORE: "InstallationCore", WORKSPACE_HOST: "TestWorkspaceHost" },
  externalNode: true,
};

const LOCAL_ORIGIN = "http://127.0.0.1:8787";
const PROOF = "W".repeat(43);
const MACHINE = "machine-workspace-test";
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
  container: {
    running: boolean;
    agent: string | null;
    starts: { instance: unknown; enableInternet: boolean; labels: string[]; env: Record<string, string> }[];
    destroys: number;
    timeouts: number[];
    inputs: { agent: string; threadId: string; inputId: string; text: string; turnId: string }[];
    served: string[];
  };
  families: Record<string, { version: number; name: string }[]>;
  tables: string[];
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
    name: "a bound workspace migrates its Host SQL as families, starts its container only through the sandbox provider and serves Host inputs through the module",
    async run({ runtime }) {
      const instance = await runtime.start(WORKSPACE_HOST_DO_SPEC, { vars: vars(), localOrigin: LOCAL_ORIGIN });
      try {
        const workspace = workspaceId();
        const ws = client(instance, workspace);
        // Unbound: nothing migrated, nothing started.
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
        });
        for (const table of ["execution_leases", "interrupted_turns", "opencraft_thread_catalog", "thread_creations"])
          assert.ok(state.tables.includes(table), table);
        assert.ok(!state.tables.includes("schema_migrations"), "no single-chain ledger");
        assert.equal(state.container.starts.length, 0);
        // Rebinding the same workspace is a no-op; another identity is refused.
        assert.equal((await ws.open()).status, 200);
        assert.equal(
          (
            await instance.fetch(`${instance.origin}/__owner/${workspace}/open`, {
              method: "POST",
              body: JSON.stringify({ workspace, machine: "other" }),
            })
          ).status,
          409,
        );

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
          (value) => value.recovery?.state === "running" && value.recovery.attempts === 1,
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
