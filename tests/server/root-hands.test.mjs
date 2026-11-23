import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDS_OWNER_PROCESSES } from "../../scripts/container-deployment/hands-application.mjs";
import {
  handsOwnerSpawnOptions,
  resolveHandsOwnerPrivileges,
} from "../../scripts/container-deployment/hands-owner-privileges.mjs";
import {
  ROOT_HANDS_CREDENTIALS,
  prepareRootHands,
  prepareRootWorkspace,
  rootHandsConfiguration,
  rootHandsOwnerComposition,
  startRootHands,
  synchronizeRootHands,
} from "../../scripts/container-deployment/root-hands.mjs";
import {
  createAgentIncarnation,
  createWorkspaceAgentSupervisor,
  prepareAgentRunDirectory,
} from "../../scripts/container-deployment/workspace-agent-supervisor.mjs";
import { browserRole, handsRole } from "../../scripts/container-deployment/workspace-agent-roles.mjs";
import { assertGenericAgentIdentity } from "../../scripts/container-deployment/workspace-agent-application.mjs";
import { serveSandboxLink } from "@opencraft/sandbox-node/static-docker";

const CLIENT = { uid: 47124, gid: 47125 };
const environment = Object.freeze({
  OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY: "/ipc/server",
  OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY: "/ipc/client",
  OPENCRAFT_HANDS_CLIENT_DIRECTORY: "/var/lib/opencraft/execution",
  OPENCRAFT_EXECUTION_DIR: "/ipc/server",
  OPENCRAFT_HANDS_CLIENT_UID: String(CLIENT.uid),
  OPENCRAFT_HANDS_CLIENT_GID: String(CLIENT.gid),
});
// Ownership changes need UID 0; CI containers and the cloud toolchain run as root.
const rootOnly = { skip: process.getuid?.() !== 0 && "requires UID 0 to create directories for another identity" };

test("configuration requires explicit portable paths and a nonroot client identity", () => {
  assert.deepEqual(rootHandsConfiguration(environment), {
    server: "/ipc/server",
    client: "/ipc/client",
    publicClient: "/var/lib/opencraft/execution",
    browserName: "browser",
    ...CLIENT,
  });
  assert.equal(rootHandsConfiguration({ ...environment, OPENCRAFT_HANDS_BROWSER_NAME: "." }).browserName, ".");
  assert.equal(
    rootHandsConfiguration({ ...environment, OPENCRAFT_HANDS_BROWSER_DIRECTORY: "/ipc" }).browserDirectory,
    "/ipc",
  );
  // The values the standard compose profile renders are accepted as they are.
  rootHandsConfiguration({
    ...environment,
    OPENCRAFT_HANDS_EXECUTION_SOCKET: "/ipc/server/exec-owner.sock",
    OPENCRAFT_HANDS_EXECUTION_TOKEN: "/ipc/server/exec-owner.token",
    OPENCRAFT_BROWSER_DATA_DIR: "/ipc/server/browser",
  });
  const rejected = [
    {},
    { OPENCRAFT_HANDS_CLIENT_UID: "0" },
    { OPENCRAFT_HANDS_CLIENT_GID: "root" },
    { OPENCRAFT_HANDS_CLIENT_UID: "2147483648" },
    { OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY: "/ipc/server/child" },
    { OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY: "/ipc/client/server", OPENCRAFT_EXECUTION_DIR: "/ipc/client/server" },
    { OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY: "/ipc/../server" },
    { OPENCRAFT_EXECUTION_DIR: "/other" },
    { OPENCRAFT_HANDS_EXECUTION_SOCKET: "/elsewhere/exec-owner.sock" },
    { OPENCRAFT_BROWSER_DATA_DIR: "/ipc/client/browser" },
    ...["/", "relative", "/ipc/server", "/ipc/server/browser"].map((value) => ({
      OPENCRAFT_HANDS_BROWSER_DIRECTORY: value,
    })),
    ...["..", "/tmp/profile", "nested/profile", "other"].map((value) => ({ OPENCRAFT_HANDS_BROWSER_NAME: value })),
  ];
  for (const change of rejected)
    assert.throws(
      () => rootHandsConfiguration(Object.keys(change).length ? { ...environment, ...change } : change),
      JSON.stringify(change),
    );
});

test("preparation refuses to run without UID 0 before touching the filesystem", async () => {
  await assert.rejects(
    prepareRootHands(rootHandsConfiguration(environment), { currentUid: 1000 }),
    /requires the Hands supervisor to run as UID 0/,
  );
});

test("UID 0 without the contract fails: the generic agent entry refuses Hands roles and root Hands needs every variable", async () => {
  for (const roles of [["hands"], ["browser"], ["hands", "browser"], ["brain", "hands"]])
    assert.throws(() => assertGenericAgentIdentity(roles, 0), /OPENCRAFT_ROOT_HANDS_\*/);
  assert.deepEqual(assertGenericAgentIdentity(["hands", "browser"], 1000), ["hands", "browser"]);
  assert.deepEqual(assertGenericAgentIdentity(["brain"], 0), ["brain"]);
  let started = false;
  await assert.rejects(
    startRootHands({ env: {}, currentUid: 0, start: async () => (started = true) }),
    /must be a normalized absolute path/,
  );
  assert.equal(started, false, "no agent starts without the contract");
});

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "opencraft-root-hands-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = { server: join(root, "server"), client: join(root, "client"), browserName: "browser", ...CLIENT };
  c.publicClient = c.client;
  for (const [path, owner] of [
    [c.server, { uid: 0, gid: 0 }],
    [c.client, CLIENT],
  ]) {
    fs.mkdirSync(path, { mode: 0o700 });
    fs.chownSync(path, owner.uid, owner.gid);
  }
  return { root, c: { ...c, ...overrides } };
}

async function listen(t, path, owner) {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(path, accept);
  });
  fs.chownSync(path, owner.uid, owner.gid);
  t.after(() => new Promise((accept) => server.close(accept)));
}

test("credential copies keep their own owners and survive restart without rotation", rootOnly, async (t) => {
  const { c } = await fixture(t);
  await prepareRootHands(c);
  const before = [];
  for (const name of ROOT_HANDS_CREDENTIALS) {
    const server = join(c.server, name),
      client = join(c.client, name);
    before.push(fs.readFileSync(server, "utf8"));
    assert.match(before.at(-1), /^[a-f0-9]{64}\n$/);
    assert.equal(fs.readFileSync(client, "utf8"), before.at(-1));
    assert.equal(fs.statSync(server).uid, 0);
    assert.equal(fs.statSync(client).uid, CLIENT.uid);
    assert.equal(fs.statSync(server).mode & 0o777, 0o600);
    assert.equal(fs.statSync(client).mode & 0o777, 0o600);
  }
  await prepareRootHands(c);
  assert.deepEqual(
    ROOT_HANDS_CREDENTIALS.map((name) => fs.readFileSync(join(c.server, name), "utf8")),
    before,
  );
  assert.equal(fs.statSync(join(c.client, "browser")).uid, CLIENT.uid);
  // The terminal is an agent endpoint only: its credential never reaches the client directory.
  assert.equal(fs.existsSync(join(c.client, "terminal.token")), false);
  // A copy lost on one side is restored from the other instead of rotating.
  fs.unlinkSync(join(c.server, "files.token"));
  await prepareRootHands(c);
  assert.equal(fs.readFileSync(join(c.server, "files.token"), "utf8"), before[1]);
});

test("mismatched credentials, links, aliases and open directories fail without repairing data", rootOnly, async (t) => {
  const { root, c } = await fixture(t);
  await prepareRootHands(c);
  const token = join(c.client, "files.token"),
    original = fs.readFileSync(join(c.server, "files.token"));
  fs.writeFileSync(token, "a".repeat(64) + "\n");
  await assert.rejects(prepareRootHands(c), /disagree/);
  assert.deepEqual(fs.readFileSync(join(c.server, "files.token")), original);
  fs.unlinkSync(token);
  fs.symlinkSync(join(c.server, "files.token"), token);
  await assert.rejects(prepareRootHands(c), /credential/);
  fs.unlinkSync(token);
  await prepareRootHands(c);
  await assert.rejects(prepareRootHands({ ...c, publicClient: c.server }), /owned by/);
  const other = join(root, "other");
  fs.mkdirSync(other, { mode: 0o700 });
  fs.chownSync(other, CLIENT.uid, CLIENT.gid);
  await assert.rejects(prepareRootHands({ ...c, publicClient: other }), /same directory/);
  fs.chmodSync(c.client, 0o755);
  await assert.rejects(prepareRootHands(c), /private/);
  assert.equal(fs.statSync(c.client).mode & 0o777, 0o755);
  fs.chmodSync(c.client, 0o700);
  fs.chownSync(c.client, CLIENT.uid + 1, CLIENT.gid);
  await assert.rejects(prepareRootHands(c), new RegExp(`owned by ${CLIENT.uid}:${CLIENT.gid}`));
  assert.equal(fs.statSync(c.client).uid, CLIENT.uid + 1);
});

test("a planted link where the default browser profile belongs is never followed or re-owned", rootOnly, async (t) => {
  const { root, c } = await fixture(t);
  const victim = join(root, "victim");
  fs.mkdirSync(victim, { mode: 0o700 });
  fs.symlinkSync(victim, join(c.client, "browser"));
  await assert.rejects(prepareRootHands(c), /not a link/);
  assert.equal(fs.statSync(victim).uid, 0);
});

test(
  "Brain's root owner sockets publish into the client directory; terminal and browser stay endpoints only",
  rootOnly,
  async (t) => {
    const { c } = await fixture(t);
    await prepareRootHands(c);
    await listen(t, join(c.server, "files.sock"), { uid: 0, gid: 0 });
    await listen(t, join(c.server, "terminal.sock"), { uid: 0, gid: 0 });
    await listen(t, join(c.client, "browser/owner.sock"), CLIENT);
    await synchronizeRootHands(c);
    assert.equal(fs.statSync(join(c.server, "files.sock")).ino, fs.statSync(join(c.client, "files.sock")).ino);
    assert.equal(fs.statSync(join(c.client, "files.sock")).mode & 0o777, 0o666);
    assert.equal(fs.statSync(c.client).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(join(c.client, "terminal.sock")), false);
    assert.equal(fs.existsSync(join(c.server, "browser")), false, "no reverse browser route into root state");
    // Missing endpoints are simply not published yet; repeating is a no-op.
    assert.equal(fs.existsSync(join(c.client, "exec-owner.sock")), false);
    await synchronizeRootHands(c);
    // A stale socket from an earlier owner incarnation is replaced atomically.
    fs.unlinkSync(join(c.server, "files.sock"));
    await listen(t, join(c.server, "files.sock"), { uid: 0, gid: 0 });
    await synchronizeRootHands(c);
    assert.equal(fs.statSync(join(c.server, "files.sock")).ino, fs.statSync(join(c.client, "files.sock")).ino);
    fs.unlinkSync(join(c.client, "files.sock"));
    fs.writeFileSync(join(c.client, "files.sock"), "do-not-replace");
    await assert.rejects(synchronizeRootHands(c), /non-socket/);
    assert.equal(fs.readFileSync(join(c.client, "files.sock"), "utf8"), "do-not-replace");
  },
);

test("a server socket owned by another identity is not published to clients", rootOnly, async (t) => {
  const { c } = await fixture(t);
  await prepareRootHands(c);
  await listen(t, join(c.server, "exec-owner.sock"), CLIENT);
  await assert.rejects(synchronizeRootHands(c), /owned by UID 0/);
  assert.equal(fs.existsSync(join(c.client, "exec-owner.sock")), false);
});

/** Agent run directories are short (socket path budget), so not below the fixture root. */
async function shortRunDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "oc-ra-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return prepareAgentRunDirectory(join(directory, "run"));
}

/** A real agent supervisor whose owner processes are stand-ins (their sockets are made by the test). */
async function fakeAgent(t) {
  const run = await shortRunDirectory(t);
  const spawned = [];
  const agent = createWorkspaceAgentSupervisor({
    runDirectory: run,
    incarnation: await createAgentIncarnation(),
    roles: ["hands", "browser"],
    log: () => {},
    spawnProcess(command, args, options, owner) {
      const child = new EventEmitter();
      Object.assign(child, { pid: process.pid, exitCode: null, signalCode: null });
      child.kill = () => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      };
      spawned.push({ options, owner });
      return child;
    },
  });
  t.after(() => agent.stop(0));
  const endpoint = (name) => join(run, "endpoints", name);
  return { agent, spawned, endpoint };
}

test(
  "the agent publishes the browser endpoint only for a socket of the dropped client identity",
  rootOnly,
  async (t) => {
    const { root, c } = await fixture(t);
    await prepareRootHands(c);
    const profile = join(c.client, "browser");
    const context = {
      paths: { runtimeDirectory: root },
      root,
      env: { OPENCRAFT_BROWSER_DATA_DIR: profile },
      ownerPrivileges: { browser: { ...CLIENT, home: c.client, stateDirectory: profile } },
    };
    const refused = await fakeAgent(t);
    await listen(t, join(profile, "owner.sock"), { uid: 0, gid: 0 });
    await assert.rejects(browserRole.start(refused.agent, context), /owned by UID 47124/);
    assert.equal(
      fs.existsSync(refused.endpoint("browser")),
      false,
      "a root socket in the client profile is never offered",
    );
    fs.chownSync(join(profile, "owner.sock"), CLIENT.uid, CLIENT.gid);
    const accepted = await fakeAgent(t);
    await browserRole.start(accepted.agent, context);
    assert.equal(await readlink(accepted.endpoint("browser")), join(profile, "owner.sock"));
    // The owner was started under the dropped identity, as a critical agent child.
    assert.deepEqual(accepted.spawned[0].owner, { role: "browser" });
    assert.equal(accepted.spawned[0].options.uid, CLIENT.uid);
    assert.equal(accepted.spawned[0].options.gid, CLIENT.gid);
    assert.equal(accepted.agent.children[0].critical, true);
  },
);

test("the agent publishes root owner endpoints only for sockets owned by root", rootOnly, async (t) => {
  const { root, c } = await fixture(t);
  await prepareRootHands(c);
  const paths = {
    runtimeDirectory: root,
    terminalEndpoint: join(c.server, "terminal.sock"),
    fileSystemEndpoint: join(c.server, "files.sock"),
    terminalToken: join(c.server, "terminal.token"),
    fileSystemToken: join(c.server, "files.token"),
  };
  const context = {
    paths,
    root,
    env: { OPENCRAFT_HANDS_EXECUTION_SOCKET: join(c.server, "exec-owner.sock") },
    ownerPrivileges: { browser: { ...CLIENT, home: c.client } },
  };
  await listen(t, join(c.server, "exec-owner.sock"), { uid: 0, gid: 0 });
  await listen(t, join(c.server, "terminal.sock"), { uid: 0, gid: 0 });
  await listen(t, join(c.server, "files.sock"), CLIENT);
  const refused = await fakeAgent(t);
  await assert.rejects(handsRole.start(refused.agent, context), /files\.sock must be a socket owned by UID 0/);
  for (const name of ["exec", "terminal", "files"]) assert.equal(fs.existsSync(refused.endpoint(name)), false, name);
  fs.chownSync(join(c.server, "files.sock"), 0, 0);
  const accepted = await fakeAgent(t);
  await handsRole.start(accepted.agent, context);
  for (const [name, socket] of [
    ["exec", "exec-owner.sock"],
    ["terminal", "terminal.sock"],
    ["files", "files.sock"],
  ])
    assert.equal(await readlink(accepted.endpoint(name)), join(c.server, socket));
  // Execution, terminal and files keep the agent's root identity.
  assert.deepEqual(
    accepted.spawned.map(({ options, owner }) => [owner.role, options.uid]),
    [
      ["execution", undefined],
      ["terminal", undefined],
      ["files", undefined],
    ],
  );
});

test("the root agent serves its static-docker link to the client identity only", rootOnly, async (t) => {
  const { c } = await fixture(t);
  const run = await shortRunDirectory(t);
  const options = {
    directory: c.client,
    incarnation: await createAgentIncarnation(),
    python: "/usr/bin/python3",
    policy: "relay-only",
    endpointDirectory: join(run, "endpoints"),
    limits: async () => ({ cpuMillis: null, memoryBytes: null, tasks: null }),
    owner: CLIENT,
  };
  for (const owner of [
    { uid: 0, gid: 0 },
    { uid: CLIENT.uid, gid: 0 },
  ])
    await assert.rejects(serveSandboxLink({ ...options, owner }), /nonroot Host identity/);
  // The link directory must already be the client's private directory; it is never re-owned.
  await assert.rejects(serveSandboxLink({ ...options, directory: c.server }), /owned by the link's Host identity/);
  assert.equal(fs.statSync(c.server).uid, 0);
  const link = await serveSandboxLink(options);
  t.after(() => link.close());
  for (const name of ["link.sock", "ticket"]) {
    const info = fs.lstatSync(join(c.client, name));
    assert.deepEqual([info.uid, info.gid], [CLIENT.uid, CLIENT.gid], name);
  }
  assert.equal(fs.lstatSync(join(c.client, "ticket")).mode & 0o777, 0o600);
  assert.ok(fs.lstatSync(join(c.client, "link.sock")).isSocket());
});

test("new projectless directories belong to the client; retained ones are never re-owned", rootOnly, async (t) => {
  const { c } = await fixture(t);
  const workspace = join(c.client, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.chownSync(workspace, CLIENT.uid, CLIENT.gid);
  await prepareRootWorkspace(c, { OPENCRAFT_WORKSPACE_DIR: workspace });
  for (const name of ["sessions", "sessions/codex", "sessions/dsh"])
    assert.equal(fs.statSync(join(workspace, name)).uid, CLIENT.uid);
  const retained = join(workspace, "retained");
  fs.mkdirSync(retained, { mode: 0o700 });
  await prepareRootWorkspace(c, { OPENCRAFT_WORKSPACE_DIR: workspace, OPENCRAFT_CODEX_PROJECTLESS_DIR: retained });
  assert.equal(fs.statSync(retained).uid, 0);
  // Cwds outside the workspace are retained as they are, not created.
  await prepareRootWorkspace(c, {
    OPENCRAFT_WORKSPACE_DIR: workspace,
    OPENCRAFT_DSH_PROJECTLESS_DIR: "/elsewhere/dsh",
  });
  assert.equal(fs.existsSync("/elsewhere/dsh"), false);
  await assert.rejects(prepareRootWorkspace(c, { OPENCRAFT_WORKSPACE_DIR: "relative" }), /absolute/);
});

test(
  "a retained client-root browser profile is kept in place and served as the agent endpoint",
  rootOnly,
  async (t) => {
    const { root, c } = await fixture(t, { browserName: "." });
    fs.writeFileSync(join(c.client, "Preferences"), "retained-profile", { mode: 0o600 });
    fs.chownSync(join(c.client, "Preferences"), CLIENT.uid, CLIENT.gid);
    await prepareRootHands(c);
    assert.equal(fs.readFileSync(join(c.client, "Preferences"), "utf8"), "retained-profile");
    assert.equal(fs.existsSync(join(c.client, "browser")), false);
    await listen(t, join(c.client, "owner.sock"), CLIENT);
    const { agent, endpoint } = await fakeAgent(t);
    const { browserData, ownerPrivileges } = rootHandsOwnerComposition(c);
    await browserRole.start(agent, {
      paths: { runtimeDirectory: root },
      root,
      env: { OPENCRAFT_BROWSER_DATA_DIR: browserData },
      ownerPrivileges,
    });
    assert.equal(await readlink(endpoint("browser")), join(c.client, "owner.sock"));
  },
);

test("a retained profile at the common filesystem root is kept beside separate IPC roots", rootOnly, async (t) => {
  const { root, c } = await fixture(t);
  const browserDirectory = fs.realpathSync(root);
  fs.chownSync(browserDirectory, CLIENT.uid, CLIENT.gid);
  const configured = { ...c, browserDirectory };
  fs.writeFileSync(join(browserDirectory, "Preferences"), "retained", { mode: 0o600 });
  fs.chownSync(join(browserDirectory, "Preferences"), CLIENT.uid, CLIENT.gid);
  await prepareRootHands(configured);
  assert.equal(fs.readFileSync(join(browserDirectory, "Preferences"), "utf8"), "retained");
  assert.equal(fs.existsSync(join(c.client, "browser")), false);
  assert.equal(fs.statSync(c.server).uid, 0);
  assert.equal(fs.statSync(c.client).uid, CLIENT.uid);
  await assert.rejects(prepareRootHands({ ...c, browserDirectory: join(browserDirectory, "missing") }));
  assert.equal(fs.existsSync(join(browserDirectory, "missing")), false);
});

// The agent validates the composed browser drop against the directories preparation
// creates or retains; a mismatch would otherwise surface only at container start.
async function composedOwners(c) {
  const composition = rootHandsOwnerComposition(c);
  const privileges = await resolveHandsOwnerPrivileges(composition.ownerPrivileges, {
    roles: HANDS_OWNER_PROCESSES.map((owner) => owner.role),
    currentUid: 0,
    environment: { OPENCRAFT_BROWSER_DATA_DIR: composition.browserData },
  });
  const base = {
    env: { OPENCRAFT_BROWSER_DATA_DIR: composition.browserData, XDG_CONFIG_HOME: "/root/.config", KEEP: "1" },
  };
  return {
    composition,
    privileges,
    browser: handsOwnerSpawnOptions(base, privileges.browser),
    execution: handsOwnerSpawnOptions(base, privileges.execution),
  };
}

test("the agent's browser privilege drop accepts the prepared default layout", rootOnly, async (t) => {
  const { c } = await fixture(t);
  await prepareRootHands(c);
  const { composition, privileges, browser, execution } = await composedOwners(c);
  assert.deepEqual(
    { ...privileges.browser },
    { ...CLIENT, home: c.publicClient, stateDirectory: join(c.publicClient, "browser") },
  );
  assert.deepEqual(composition.linkOwner, CLIENT);
  assert.equal(browser.uid, CLIENT.uid);
  assert.equal(browser.env.OPENCRAFT_BROWSER_DATA_DIR, join(c.publicClient, "browser"));
  assert.equal(browser.env.HOME, c.publicClient);
  assert.equal(browser.env.XDG_CONFIG_HOME, undefined);
  assert.equal(browser.env.KEEP, "1");
  // Owners that keep root identity are spawned unchanged.
  assert.equal(execution.uid, undefined);
  assert.equal(execution.env.XDG_CONFIG_HOME, "/root/.config");
});

test(
  "the agent's browser privilege drop accepts retained client-root and common-root profiles",
  rootOnly,
  async (t) => {
    const legacy = (await fixture(t, { browserName: "." })).c;
    await prepareRootHands(legacy);
    assert.equal((await composedOwners(legacy)).browser.env.OPENCRAFT_BROWSER_DATA_DIR, legacy.publicClient);
    const { root, c } = await fixture(t);
    const browserDirectory = fs.realpathSync(root);
    fs.chownSync(browserDirectory, CLIENT.uid, CLIENT.gid);
    const configured = { ...c, browserDirectory };
    await prepareRootHands(configured);
    const { privileges, browser } = await composedOwners(configured);
    assert.equal(privileges.browser.stateDirectory, browserDirectory);
    assert.equal(browser.env.HOME, browserDirectory);
  },
);

test(
  "startup prepares the layout, then starts the Hands agent with the drop, the link owner and Brain's bridge",
  rootOnly,
  async (t) => {
    const { root, c } = await fixture(t);
    const workspace = join(root, "workspace");
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.chownSync(workspace, CLIENT.uid, CLIENT.gid);
    const env = {
      OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY: c.server,
      OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY: c.client,
      OPENCRAFT_HANDS_CLIENT_DIRECTORY: c.publicClient,
      OPENCRAFT_EXECUTION_DIR: c.server,
      OPENCRAFT_BROWSER_DATA_DIR: join(c.server, "browser"),
      OPENCRAFT_HANDS_CLIENT_UID: String(CLIENT.uid),
      OPENCRAFT_HANDS_CLIENT_GID: String(CLIENT.gid),
      OPENCRAFT_WORKSPACE_DIR: workspace,
    };
    let started;
    await startRootHands({
      env,
      currentUid: 0,
      start: async (options) => {
        started = options;
      },
    });
    assert.deepEqual(Object.keys(started.ownerPrivileges), ["browser"]);
    assert.deepEqual(started.linkOwner, CLIENT);
    assert.equal(started.env, env);
    assert.equal(env.OPENCRAFT_BROWSER_DATA_DIR, join(c.publicClient, "browser"));
    assert.ok(fs.existsSync(join(c.client, "files.token")));
    assert.equal(fs.statSync(join(workspace, "sessions/codex")).uid, CLIENT.uid);
    // Brain's bridge runs inside the agent: it publishes sockets and stops the agent on failure.
    let failed = 0;
    const [service] = await started.startServices(() => failed++);
    t.after(() => service.close());
    await listen(t, join(c.server, "exec-owner.sock"), { uid: 0, gid: 0 });
    await waitFor(() => fs.existsSync(join(c.client, "exec-owner.sock")));
    fs.writeFileSync(join(c.client, "files.sock"), "not a socket");
    await listen(t, join(c.server, "files.sock"), { uid: 0, gid: 0 });
    await waitFor(() => failed === 1);
  },
);

test("the packaged Hands entry selects root mode only for UID 0", async () => {
  const entry = await readFile(new URL("../../scripts/container-deployment/hands.mjs", import.meta.url), "utf8");
  assert.match(entry, /process\.getuid\?\.\(\) === 0\) await startRootHands\(\)/);
  assert.match(entry, /else await startContainerHands\(\)/);
  const generic = await readFile(
    new URL("../../scripts/container-deployment/workspace-agent.mjs", import.meta.url),
    "utf8",
  );
  assert.match(generic, /assertGenericAgentIdentity\(parseAgentRoles\(/);
});

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((accept) => setTimeout(accept, 20));
  }
  assert.fail("condition was not reached");
}
