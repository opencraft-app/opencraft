import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentIncarnation,
  createWorkspaceAgentSupervisor,
  prepareAgentRunDirectory,
  probeWorkspaceAgent,
} from "../../scripts/container-deployment/workspace-agent-supervisor.mjs";
import {
  parseAgentRoles,
  startWorkspaceAgent,
} from "../../scripts/container-deployment/workspace-agent-application.mjs";
import { holdBrainDataDirectory, relaunchBrainOwners } from "../../scripts/container-deployment/workspace-agent-roles.mjs";
import { deploymentPaths } from "../../scripts/container-deployment/paths.mjs";
import { createHandsTerminalService } from "../../apps/headless-server/src/host-terminal-transport.ts";

const until = async (read, accept = Boolean, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    let value;
    try {
      value = await read();
      if (accept(value)) return value;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function supervisorFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "oc-agent-"));
  const runDirectory = await prepareAgentRunDirectory(join(directory, "run"));
  const events = [];
  const agent = createWorkspaceAgentSupervisor({
    runDirectory,
    incarnation: await createAgentIncarnation(),
    roles: ["test"],
    log: (value) => events.push(value),
    stopTimeoutMs: 2000,
  });
  t.after(async () => {
    await agent.stop(0);
    await rm(directory, { recursive: true, force: true });
  });
  // A child that records its start and stays alive until signalled.
  const child = (name, options = {}) =>
    agent.start(
      name,
      process.execPath,
      [
        "-e",
        `require('fs').appendFileSync(${JSON.stringify(join(directory, "order"))}, ${JSON.stringify(name + "\n")}); setInterval(() => {}, 1000)`,
      ],
      options,
    );
  return {
    directory,
    runDirectory,
    agent,
    events,
    child,
    order: async () => (await readFile(join(directory, "order"), "utf8")).trim().split("\n"),
  };
}

// The Brain's data-directory lock was a proper-lockfile mtime lease: a second Brain took over
// one whose lease looked 10s old (a stalled event loop), and the holder's refresh timer threw.
test("a Brain whose data-directory lock looks unrefreshed is never replaced and never fails from a timer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "brain-lock-"));
  const uncaught = [],
    record = (error) => uncaught.push(error);
  process.on("uncaughtException", record);
  const release = await holdBrainDataDirectory(root);
  let contender;
  t.after(async () => {
    process.off("uncaughtException", record);
    await contender?.();
    await release();
    await rm(root, { recursive: true, force: true });
  });
  const lock = join(root, "native-host.lock"),
    expired = new Date(Date.now() - 120_000);
  await utimes(lock, expired, expired);
  await assert.rejects(
    holdBrainDataDirectory(root).then((started) => {
      contender = started;
    }),
    { code: "ELOCKED" },
  );
  await new Promise((resolve) => setTimeout(resolve, 6000));
  assert.deepEqual(uncaught, []);
  assert.equal((await lstat(lock)).isFile(), true);
});

test("incarnations are unique per start and bound to process birth evidence", async () => {
  const [first, second] = await Promise.all([createAgentIncarnation(), createAgentIncarnation()]);
  assert.match(first.id, /^[0-9a-f]{32}$/u);
  assert.notEqual(first.id, second.id);
  assert.equal(first.evidence, second.evidence, "same process birth, different incarnation ids");
  const recycled = await createAgentIncarnation({
    pid: process.pid,
    readText: async (path) =>
      path.endsWith("/stat")
        ? (await readFile(`/proc/${process.pid}/stat`, "utf8")).replace(
            /\) (\S+ (?:\S+ ){18})(\d+)/u,
            (_, before, ticks) => `) ${before}${Number(ticks) + 1}`,
          )
        : readFile(path, "utf8"),
  });
  assert.notEqual(
    recycled.evidence,
    first.evidence,
    "a recycled PID with another birth time is a different incarnation",
  );
});

test("the run directory is private and cleared; endpoint names are allow-listed", async (t) => {
  const f = await supervisorFixture(t);
  assert.equal((await stat(f.runDirectory)).mode & 0o777, 0o700);
  await writeFile(join(f.runDirectory, "stale.sock"), "");
  await prepareAgentRunDirectory(f.runDirectory);
  await assert.rejects(lstat(join(f.runDirectory, "stale.sock")), { code: "ENOENT" });
  await assert.rejects(prepareAgentRunDirectory("relative/run"), /absolute/);
  await f.agent.serveControl();
  for (const name of ["../escape", "unknown", "control", "/etc/passwd", "Files"])
    await assert.rejects(f.agent.publishEndpoint(name, "/tmp/x.sock"), /not allowed/);
  await assert.rejects(f.agent.publishEndpoint("files", "relative.sock"), /absolute/);
  await f.agent.publishEndpoint("files", "/tmp/files.sock");
  assert.equal(await readlink(join(f.runDirectory, "endpoints", "files")), "/tmp/files.sock");
  assert.deepEqual((await probeWorkspaceAgent(join(f.runDirectory, "endpoints", "control"))).endpoints, [
    "control",
    "files",
  ]);
});

test("control reports start order, readiness and incarnation; a critical child failure ends the agent", async (t) => {
  const f = await supervisorFixture(t);
  await f.agent.serveControl();
  // Children are started one at a time, each after the previous one is running,
  // as the agent's role start does; the recorded order is then deterministic.
  const started = async (count) => until(f.order, (value) => value.length === count);
  const first = f.child("core");
  await started(1);
  const grouped = f.child("app-server", { processGroup: true });
  await started(2);
  const helper = f.child("helper", { critical: false });
  await started(3);
  assert.deepEqual(await f.order(), ["core", "app-server", "helper"]);
  const starting = await probeWorkspaceAgent(join(f.runDirectory, "control.sock"));
  assert.equal(starting.type, "starting");
  f.agent.markReady();
  const ready = await probeWorkspaceAgent(join(f.runDirectory, "control.sock"));
  assert.equal(ready.type, "healthy");
  assert.equal(ready.incarnation.id, f.agent.incarnation.id);
  assert.deepEqual(
    ready.components.map((c) => [c.name, c.pid, c.critical]),
    [
      ["core", first.pid, true],
      ["app-server", grouped.pid, true],
      ["helper", helper.pid, false],
    ],
  );
  // A non-critical child may end; the agent continues.
  helper.signal("SIGKILL");
  await helper.exited;
  assert.equal((await probeWorkspaceAgent(join(f.runDirectory, "control.sock"))).type, "healthy");
  // A critical child failure stops every other child and ends the agent with code 1.
  first.signal("SIGKILL");
  assert.equal(await f.agent.exited, 1);
  assert.equal(alive(grouped.pid), false);
  assert.ok(f.events.some((event) => event.type === "workspace-agent-child-failed" && event.name === "core"));
  await assert.rejects(probeWorkspaceAgent(join(f.runDirectory, "control.sock")));
});

test("a deliberate replacement is not a failure; drain stops the agent cleanly", async (t) => {
  const f = await supervisorFixture(t);
  await f.agent.serveControl();
  const original = f.child("app-server", { processGroup: true });
  f.agent.markReady();
  const next = await f.agent.replace(original, () => f.child("app-server", { processGroup: true }));
  assert.notEqual(next.pid, original.pid);
  assert.equal(alive(original.pid), false);
  assert.equal((await probeWorkspaceAgent(join(f.runDirectory, "control.sock"))).components.length, 1);
  assert.equal(
    (await probeWorkspaceAgent(join(f.runDirectory, "control.sock"), { request: { type: "drain" } })).type,
    "draining",
  );
  assert.equal(await f.agent.exited, 0);
  assert.equal(alive(next.pid), false);
});

test("an ENV issuer relaunch retires Pi, DSH and the AppServer group through the supervisor and restarts them configured", async (t) => {
  const f = await supervisorFixture(t);
  await f.agent.serveControl();
  const issuerFile = join(f.directory, "issuer");
  await writeFile(issuerFile, "first");
  // Each owner records the issuer its launch configuration held when it started.
  const owner = (name, options = {}) =>
    f.agent.start(
      name,
      process.execPath,
      [
        "-e",
        `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(join(f.directory, "order"))}, ${JSON.stringify(name)} + ':' + fs.readFileSync(${JSON.stringify(issuerFile)}, 'utf8') + '\\n');
    ${
      options.processGroup
        ? `const native = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(join(f.directory, "native"))}, String(native.pid));`
        : ""
    }
    setInterval(() => {}, 1000)`,
      ],
      options,
    );
  const startAppServer = () => owner("codex-app-server", { processGroup: true });
  const startHosts = () => ({ dshHost: owner("dsh-host"), engineHost: owner("engine-host") });
  const started = (count) => until(f.order, (value) => value.length === count);
  const owners = { appServer: startAppServer() };
  await started(1);
  const native = Number(await until(() => readFile(join(f.directory, "native"), "utf8")));
  Object.assign(owners, startHosts());
  await started(3);
  f.agent.markReady();
  assert.equal((await probeWorkspaceAgent(join(f.runDirectory, "control.sock"))).endpointGeneration, 0);
  const before = { ...owners };
  const steps = [];
  await relaunchBrainOwners(f.agent, owners, {
    configure: async () => {
      // Every owner of the old key has ended before its configuration is rewritten.
      steps.push([
        "configure",
        ...[before.engineHost, before.dshHost, before.appServer].map((owner) => alive(owner.pid)),
      ]);
      await writeFile(issuerFile, "second");
    },
    startAppServer,
    startHosts,
    appServerReady: () => started(4),
    hostsReady: () => started(6),
  });
  assert.deepEqual(steps, [["configure", false, false, false]]);
  await until(() => !alive(native)); // the AppServer's native process group ends with it
  // The AppServer starts before DSH and Pi (which start together), each time with the configuration then current.
  const order = await f.order();
  assert.deepEqual(
    [order[0], ...order.slice(1, 3).sort(), order[3], ...order.slice(4).sort()],
    [
      "codex-app-server:first",
      "dsh-host:first",
      "engine-host:first",
      "codex-app-server:second",
      "dsh-host:second",
      "engine-host:second",
    ],
  );
  for (const name of ["appServer", "dshHost", "engineHost"]) assert.notEqual(owners[name].pid, before[name].pid, name);
  // Deliberate retirement is not a child failure: the agent stays healthy with the successors only.
  const probe = await probeWorkspaceAgent(join(f.runDirectory, "control.sock"));
  assert.equal(probe.type, "healthy");
  // Same incarnation, new DSH/Pi descriptors: a Host observing the agent reads them again.
  assert.equal(probe.endpointGeneration, 1);
  assert.equal(probe.incarnation.id, f.agent.incarnation.id);
  assert.deepEqual(
    probe.components.map((c) => [c.name, c.pid]),
    [
      ["codex-app-server", owners.appServer.pid],
      ["dsh-host", owners.dshHost.pid],
      ["engine-host", owners.engineHost.pid],
    ],
  );
  assert.ok(!f.events.some((event) => event.type === "workspace-agent-child-failed"));
  // The successors are ordinary critical children: losing one still ends the agent.
  owners.dshHost.signal("SIGKILL");
  assert.equal(await f.agent.exited, 1);
});

test("an ENV issuer relaunch whose successor does not become ready leaves the caller to end the agent", async (t) => {
  const f = await supervisorFixture(t);
  const owners = {
    appServer: f.child("codex-app-server", { processGroup: true }),
    dshHost: f.child("dsh-host"),
    engineHost: f.child("engine-host"),
  };
  f.agent.markReady();
  await assert.rejects(
    relaunchBrainOwners(f.agent, owners, {
      configure: async () => {},
      startAppServer: () => f.child("codex-app-server", { processGroup: true }),
      startHosts: () => ({ dshHost: f.child("dsh-host"), engineHost: f.child("engine-host") }),
      appServerReady: () =>
        f.agent.waitUntil(() => Promise.reject(new Error("no health")), {
          attempts: 2,
          delayMs: 1,
          description: "Codex execution owner",
        }),
      hostsReady: async () => assert.fail("hosts start only after the AppServer is ready"),
    }),
    /Codex execution owner did not become ready/,
  );
  assert.equal(f.agent.describe().endpointGeneration, 0, "no successor is announced before it is ready");
  // A stopping agent rewrites nothing and starts no successor.
  await f.agent.stop(1, "Environment issuer relaunch failed");
  await relaunchBrainOwners(f.agent, owners, {
    configure: async () => assert.fail("no rewrite while stopping"),
    startAppServer: () => assert.fail("no start while stopping"),
    startHosts: () => assert.fail("no start while stopping"),
    appServerReady: async () => {},
    hostsReady: async () => {},
  });
});

test("a child that cannot start is a critical failure", async (t) => {
  const f = await supervisorFixture(t);
  f.agent.start("missing", join(f.directory, "no-such-binary"));
  assert.equal(await f.agent.exited, 1);
});

async function handsFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "oc-agent-hands-"));
  const root = join(directory, "opencraft"),
    runtime = join(root, "runtime");
  await mkdir(join(runtime, "browser"), { recursive: true });
  await mkdir(join(root, "bin"));
  await symlink(process.execPath, join(root, "bin", "node"));
  const listen = (path) => `require('net').createServer(s => s.end()).listen(${path}); setInterval(() => {}, 1000)`;
  await writeFile(
    join(runtime, "hands-execution-owner.mjs"),
    `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); ${listen("process.env.OPENCRAFT_HANDS_EXECUTION_SOCKET")}`,
  );
  await writeFile(
    join(runtime, "hands-files-owner.mjs"),
    `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); ${listen("process.env.OPENCRAFT_EXECUTION_DIR + '/files.sock'")}`,
  );
  await writeFile(
    join(runtime, "browser", "owner.cjs"),
    listen("process.env.OPENCRAFT_BROWSER_DATA_DIR + '/owner.sock'"),
  );
  // The real terminal owner (PTYs), without the cgroup check that needs a Hands container.
  await writeFile(
    join(runtime, "hands-terminal-owner.mjs"),
    `
    if (process.argv[2] !== '--hands-terminal-owner') throw new Error('role argument missing');
    process.argv.length = 2; // the packaged entry's own main would verify the Hands cgroup
    process.chdir(${JSON.stringify(new URL("../..", import.meta.url).pathname)}); // source workers resolve tsx from the checkout
    const { startHandsTerminal } = await import(${JSON.stringify(new URL("../../scripts/container-deployment/terminal.mjs", import.meta.url).href)});
    const { deploymentPaths } = await import(${JSON.stringify(new URL("../../scripts/container-deployment/paths.mjs", import.meta.url).href)});
    const stop = await startHandsTerminal(deploymentPaths(), { verify: false });
    process.once('SIGTERM', () => void stop().then(() => process.exit(0)));`,
  );
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import=${import.meta.resolve("tsx")}`,
    OPENCRAFT_DATA_DIR: join(directory, "state"),
    OPENCRAFT_WORKSPACE_DIR: join(directory, "work"),
    OPENCRAFT_EXECUTION_DIR: join(directory, "state", "execution"),
    OPENCRAFT_BROWSER_DATA_DIR: join(directory, "state", "execution", "browser"),
    OPENCRAFT_HANDS_EXECUTION_SOCKET: join(directory, "state", "execution", "exec-owner.sock"),
    OPENCRAFT_AGENT_RUN_DIR: join(directory, "run"),
  };
  const paths = deploymentPaths(env);
  await mkdir(paths.executionDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtimeDirectory, { recursive: true });
  const signals = new EventEmitter();
  const agent = await startWorkspaceAgent({ roles: ["hands", "browser"], env, root, signals });
  t.after(async () => {
    await agent.stop(0);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, env, paths, agent, signals };
}

test("the Hands agent starts its owners, publishes named endpoints and keeps PTYs across client disconnects", async (t) => {
  const f = await handsFixture(t);
  const control = join(f.paths.agentRunDirectory, "endpoints", "control");
  const ready = await until(
    () => probeWorkspaceAgent(control),
    (value) => value.type === "healthy",
  );
  assert.deepEqual(ready.roles, ["hands", "browser"]);
  assert.deepEqual(
    ready.components.map((c) => c.name),
    ["exec", "terminal", "files", "browser"],
  );
  assert.deepEqual(ready.endpoints, ["browser", "control", "exec", "files", "terminal"]);
  // Clients reach the terminal owner through its named endpoint, never a guessed path.
  const terminalEndpoint = join(f.paths.agentRunDirectory, "endpoints", "terminal");
  assert.equal(await readlink(terminalEndpoint), f.paths.terminalEndpoint);
  const scope = { account: "alice", hostId: "local-codex", threadId: "thread", projectId: null };
  const output = (snapshot) =>
    (snapshot.output ?? []).map((entry) => Buffer.from(entry.deltaBase64, "base64").toString()).join("");
  const client = () =>
    createHandsTerminalService({
      directory: f.paths.terminalDirectory,
      endpoint: terminalEndpoint,
      tokenFile: f.paths.terminalToken,
    });
  const first = client();
  await first.dispatch(
    "process/spawn",
    {
      processHandle: "kept",
      cwd: f.paths.runtimeDirectory,
      command: ["/bin/bash", "--noprofile", "--norc"],
      tty: true,
      size: { cols: 80, rows: 24 },
      threadId: "thread",
    },
    scope,
  );
  await first.dispatch(
    "process/writeStdin",
    { processHandle: "kept", deltaBase64: Buffer.from("printf 'PTY_PID=%s\\n' $$\n").toString("base64") },
    scope,
  );
  const before = await until(
    () => first.dispatch("process/attach", { processHandle: "kept", afterSequence: 0 }, scope),
    (value) => /PTY_PID=\d+/.test(output(value)),
  );
  const pid = Number(output(before).match(/PTY_PID=(\d+)/)[1]);
  first.close(); // The WorkspaceHost/Gateway side disconnects.
  const second = client();
  t.after(() => second.close());
  await second.dispatch(
    "process/writeStdin",
    { processHandle: "kept", deltaBase64: Buffer.from("printf 'AGAIN=%s\\n' $$\n").toString("base64") },
    scope,
  );
  await until(
    () => second.dispatch("process/attach", { processHandle: "kept", afterSequence: before.nextSequence }, scope),
    (value) => output(value).includes(`AGAIN=${pid}`),
  );
  assert.equal(alive(pid), true);
  // Losing a critical owner ends the agent (a new incarnation), and with it the PTY.
  const files = ready.components.find((c) => c.name === "files").pid;
  process.kill(files, "SIGKILL");
  assert.equal(await f.agent.exited, 1);
  await until(() => !alive(pid));
  for (const component of ready.components) assert.equal(alive(component.pid), false, component.name);
});

test("role selection is explicit composition", async () => {
  assert.deepEqual(parseAgentRoles(["--role", "hands", "--role", "browser"]), ["hands", "browser"]);
  assert.throws(() => parseAgentRoles(["brain"]), /Usage/);
  assert.throws(() => parseAgentRoles([]), /Usage/);
  assert.deepEqual(parseAgentRoles(["--bare"]), [], "a bare environment runs only control and its provider link");
  for (const roles of [["provider-e2b"], ["hands", "hands"]])
    await assert.rejects(startWorkspaceAgent({ roles, env: {} }), /roles/);
});

test(
  "the static-docker link serves only allow-listed endpoint relays behind a one-time ticket",
  { timeout: 60_000 },
  async (t) => {
    const { serveAgentLink } = await import("../../scripts/container-deployment/workspace-agent-application.mjs");
    const { staticDockerSandboxBackend, readSandboxLinkTicket } = await import("@opencraft/sandbox-node/static-docker");
    const { createSandboxPool, describeWorkspaceEndpoint, openSandboxEndpoint, probeWorkspaceAgent, SandboxFault } =
      await import("@opencraft/sandbox");
    const root = await mkdtemp(join(tmpdir(), "oc-link-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const run = await prepareAgentRunDirectory(join(root, "run")),
      link = join(root, "link");
    await mkdir(link, { mode: 0o700 });
    const agent = createWorkspaceAgentSupervisor({
      runDirectory: run,
      incarnation: await createAgentIncarnation(),
      roles: ["hands"],
      log: () => {},
    });
    t.after(() => agent.stop(0));
    await agent.serveControl();
    await agent.publishEndpoint("terminal", join(run, "unused.sock"), async () => ({ token: "x".repeat(32) }));
    agent.markReady();
    const budget = { cpuMillis: 2000, memoryBytes: 1024 ** 3 };
    await serveAgentLink(
      agent,
      { agentLinkDirectory: link, agentEndpointDirectory: join(run, "endpoints") },
      {},
      { limits: async () => ({ ...budget, tasks: null }) },
    );
    const firstTicket = await readSandboxLinkTicket(link);
    const pool = await createSandboxPool(
      { id: "link", capacity: budget, defaults: budget },
      staticDockerSandboxBackend({ directory: link }),
    );
    t.after(() => pool.close().catch(() => {}));
    const sandbox = await pool.createSandbox({ owner: "test" });
    assert.deepEqual(sandbox.receipt, { backend: "static-docker", instanceId: agent.incarnation.id });
    assert.notEqual(await readSandboxLinkTicket(link), firstTicket, "the ticket is one-time");
    assert.equal(sandbox.capabilities.terminal, false, "relay-only links offer no terminals");
    const location = { endpointDirectory: join(run, "endpoints") };
    assert.equal((await probeWorkspaceAgent(sandbox, location)).incarnation.id, agent.incarnation.id);
    assert.deepEqual(await describeWorkspaceEndpoint(sandbox, "terminal", location), { token: "x".repeat(32) });
    // relay-only: arbitrary commands and relays outside the endpoint directory never start.
    // The refusal reaches the Host as the fault's cause, not only as a generic start failure.
    await assert.rejects(
      sandbox.spawn({ command: ["/bin/echo", "escape"], cwd: "/", env: {}, attached: true }),
      (e) =>
        e instanceof SandboxFault &&
        e.code === "SANDBOX_START" &&
        /broker reported an error: policy/u.test(e.cause?.message),
    );
    const outside = await openSandboxEndpoint(sandbox, {
      target: { unix: join(run, "control.sock") },
      onData() {},
    }).catch((error) => error);
    assert.ok(outside instanceof SandboxFault, "a relay to a raw path is refused");
    // A copied (consumed) ticket no longer attaches.
    await assert.rejects(
      staticDockerSandboxBackend({ directory: link, readTicket: async () => firstTicket }).create(
        { id: "x", owner: "x", backend: "static-docker" },
        budget,
        new AbortController().signal,
      ),
      (e) => e?.outcome === "not-created",
    );
    await sandbox.close();
    await pool.close();
  },
);

test(
  "an agent whose image lacks the link interpreter fails its start instead of refusing every process",
  { timeout: 30_000 },
  async (t) => {
    const { serveAgentLink } = await import("../../scripts/container-deployment/workspace-agent-application.mjs");
    const root = await mkdtemp(join(tmpdir(), "oc-link-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const run = await prepareAgentRunDirectory(join(root, "run")),
      link = join(root, "link");
    await mkdir(link, { mode: 0o700 });
    const deferred = [];
    const agent = { incarnation: await createAgentIncarnation(), defer: (close) => deferred.push(close) };
    t.after(() => Promise.all(deferred.map((close) => close())));
    const missing = join(root, "no-python3");
    await assert.rejects(
      serveAgentLink(
        agent,
        { agentLinkDirectory: link, agentEndpointDirectory: join(run, "endpoints") },
        { OPENCRAFT_AGENT_PYTHON: missing },
        { limits: async () => ({ cpuMillis: 1000, memoryBytes: 1024 ** 3, tasks: null }) },
      ),
      (error) =>
        error.message === `Sandbox link interpreter ${missing} is not executable` && error.cause?.code === "ENOENT",
    );
    // Nothing was published: a Gateway never attaches to a link that cannot run a broker.
    await assert.rejects(lstat(join(link, "ticket")), { code: "ENOENT" });
    await assert.rejects(lstat(join(link, "link.sock")), { code: "ENOENT" });
  },
);

test(
  "a superseding link attach ends the previous session's processes, not only their brokers",
  { timeout: 60_000 },
  async (t) => {
    const { serveAgentLink } = await import("../../scripts/container-deployment/workspace-agent-application.mjs");
    const { staticDockerSandboxBackend } = await import("@opencraft/sandbox-node/static-docker");
    const { createSandboxPool } = await import("@opencraft/sandbox");
    const root = await mkdtemp(join(tmpdir(), "oc-link-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const run = await prepareAgentRunDirectory(join(root, "run")),
      link = join(root, "link");
    await mkdir(link, { mode: 0o700 });
    const agent = createWorkspaceAgentSupervisor({
      runDirectory: run,
      incarnation: await createAgentIncarnation(),
      roles: [],
      log: () => {},
    });
    t.after(() => agent.stop(0));
    await agent.serveControl();
    agent.markReady();
    const budget = { cpuMillis: 1000, memoryBytes: 1024 ** 3 };
    // `any` is the bare/dev policy: it lets this test start an ordinary long-lived process.
    await serveAgentLink(
      agent,
      { agentLinkDirectory: link, agentEndpointDirectory: join(run, "endpoints") },
      { OPENCRAFT_AGENT_LINK_POLICY: "any" },
      { limits: async () => ({ ...budget, tasks: null }) },
    );
    const first = await createSandboxPool(
      { id: "old-host", capacity: budget, defaults: budget },
      staticDockerSandboxBackend({ directory: link }),
    );
    t.after(() => first.close().catch(() => {}));
    const stale = await first.createSandbox({ owner: "old" });
    let output = "";
    const process_ = await stale.spawn(
      { command: ["/bin/sh", "-c", "echo $$; exec sleep 600"], cwd: "/", env: {} },
      (chunk) => {
        output += Buffer.from(chunk.data).toString("utf8");
      },
    );
    const pid = Number(
      await until(
        () => output.trim(),
        (value) => /^\d+$/u.test(value),
      ),
    );
    assert.ok(alive(pid));
    // A restarted Host attaches: the stale Host's process group must end (the broker kills it on EOF).
    const second = await createSandboxPool(
      { id: "new-host", capacity: budget, defaults: budget },
      staticDockerSandboxBackend({ directory: link }),
    );
    t.after(() => second.close().catch(() => {}));
    const current = await second.createSandbox({ owner: "new" });
    await until(() => !alive(pid), Boolean, 4_000);
    await process_.exited.catch(() => {});
    await current.close();
  },
);
