import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("preparation refuses to run without UID 0 before touching the filesystem", () => {
  assert.throws(
    () => prepareRootHands(rootHandsConfiguration(environment), { currentUid: 1000 }),
    /requires the Hands supervisor to run as UID 0/,
  );
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
  prepareRootHands(c);
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
  prepareRootHands(c);
  assert.deepEqual(
    ROOT_HANDS_CREDENTIALS.map((name) => fs.readFileSync(join(c.server, name), "utf8")),
    before,
  );
  assert.equal(fs.statSync(join(c.client, "browser")).uid, CLIENT.uid);
  assert.equal(fs.statSync(join(c.server, "browser")).uid, 0);
  // A copy lost on one side is restored from the other instead of rotating.
  fs.unlinkSync(join(c.server, "files.token"));
  prepareRootHands(c);
  assert.equal(fs.readFileSync(join(c.server, "files.token"), "utf8"), before[1]);
});

test("mismatched credentials, links, aliases and open directories fail without repairing data", rootOnly, async (t) => {
  const { root, c } = await fixture(t);
  prepareRootHands(c);
  const token = join(c.client, "files.token"),
    original = fs.readFileSync(join(c.server, "files.token"));
  fs.writeFileSync(token, "a".repeat(64) + "\n");
  assert.throws(() => prepareRootHands(c), /disagree/);
  assert.deepEqual(fs.readFileSync(join(c.server, "files.token")), original);
  fs.unlinkSync(token);
  fs.symlinkSync(join(c.server, "files.token"), token);
  assert.throws(() => prepareRootHands(c), /credential/);
  fs.unlinkSync(token);
  prepareRootHands(c);
  assert.throws(() => prepareRootHands({ ...c, publicClient: c.server }), /owned by/);
  const other = join(root, "other");
  fs.mkdirSync(other, { mode: 0o700 });
  fs.chownSync(other, CLIENT.uid, CLIENT.gid);
  assert.throws(() => prepareRootHands({ ...c, publicClient: other }), /same directory/);
  fs.chmodSync(c.client, 0o755);
  assert.throws(() => prepareRootHands(c), /private/);
  assert.equal(fs.statSync(c.client).mode & 0o777, 0o755);
  fs.chmodSync(c.client, 0o700);
  fs.chownSync(c.client, CLIENT.uid + 1, CLIENT.gid);
  assert.throws(() => prepareRootHands(c), new RegExp(`owned by ${CLIENT.uid}:${CLIENT.gid}`));
  assert.equal(fs.statSync(c.client).uid, CLIENT.uid + 1);
});

test("a planted link where the default browser profile belongs is never followed or re-owned", rootOnly, async (t) => {
  const { root, c } = await fixture(t);
  const victim = join(root, "victim");
  fs.mkdirSync(victim, { mode: 0o700 });
  fs.symlinkSync(victim, join(c.client, "browser"));
  assert.throws(() => prepareRootHands(c), /not a link/);
  assert.equal(fs.statSync(victim).uid, 0);
});

test("root sockets publish into the client directory and the browser socket in reverse", rootOnly, async (t) => {
  const { c } = await fixture(t);
  prepareRootHands(c);
  await listen(t, join(c.server, "files.sock"), { uid: 0, gid: 0 });
  await listen(t, join(c.client, "browser/owner.sock"), CLIENT);
  synchronizeRootHands(c);
  assert.equal(fs.statSync(join(c.server, "files.sock")).ino, fs.statSync(join(c.client, "files.sock")).ino);
  assert.equal(fs.statSync(join(c.client, "files.sock")).mode & 0o777, 0o666);
  assert.equal(fs.statSync(c.client).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(c.server, "browser/owner.sock")).uid, CLIENT.uid);
  // Missing endpoints are simply not published yet; repeating is a no-op.
  assert.equal(fs.existsSync(join(c.client, "terminal.sock")), false);
  synchronizeRootHands(c);
  // A stale socket from an earlier owner incarnation is replaced atomically.
  fs.unlinkSync(join(c.server, "files.sock"));
  await listen(t, join(c.server, "files.sock"), { uid: 0, gid: 0 });
  synchronizeRootHands(c);
  assert.equal(fs.statSync(join(c.server, "files.sock")).ino, fs.statSync(join(c.client, "files.sock")).ino);
  fs.unlinkSync(join(c.client, "files.sock"));
  fs.writeFileSync(join(c.client, "files.sock"), "do-not-replace");
  assert.throws(() => synchronizeRootHands(c), /non-socket/);
  assert.equal(fs.readFileSync(join(c.client, "files.sock"), "utf8"), "do-not-replace");
});

test("a browser socket owned by another identity is not published to root owners", rootOnly, async (t) => {
  const { c } = await fixture(t);
  prepareRootHands(c);
  await listen(t, join(c.client, "browser/owner.sock"), { uid: 0, gid: 0 });
  assert.throws(() => synchronizeRootHands(c), /owned by UID/);
  assert.equal(fs.existsSync(join(c.server, "browser/owner.sock")), false);
});

test("new projectless directories belong to the client; retained ones are never re-owned", rootOnly, async (t) => {
  const { c } = await fixture(t);
  const workspace = join(c.client, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.chownSync(workspace, CLIENT.uid, CLIENT.gid);
  prepareRootWorkspace(c, { OPENCRAFT_WORKSPACE_DIR: workspace });
  for (const name of ["sessions", "sessions/codex", "sessions/dsh"])
    assert.equal(fs.statSync(join(workspace, name)).uid, CLIENT.uid);
  const retained = join(workspace, "retained");
  fs.mkdirSync(retained, { mode: 0o700 });
  prepareRootWorkspace(c, { OPENCRAFT_WORKSPACE_DIR: workspace, OPENCRAFT_CODEX_PROJECTLESS_DIR: retained });
  assert.equal(fs.statSync(retained).uid, 0);
  // Cwds outside the workspace are retained as they are, not created.
  prepareRootWorkspace(c, { OPENCRAFT_WORKSPACE_DIR: workspace, OPENCRAFT_DSH_PROJECTLESS_DIR: "/elsewhere/dsh" });
  assert.equal(fs.existsSync("/elsewhere/dsh"), false);
  assert.throws(() => prepareRootWorkspace(c, { OPENCRAFT_WORKSPACE_DIR: "relative" }), /absolute/);
});

test("a retained client-root browser profile is kept in place", rootOnly, async (t) => {
  const { c } = await fixture(t, { browserName: "." });
  fs.writeFileSync(join(c.client, "Preferences"), "retained-profile", { mode: 0o600 });
  fs.chownSync(join(c.client, "Preferences"), CLIENT.uid, CLIENT.gid);
  prepareRootHands(c);
  assert.equal(fs.readFileSync(join(c.client, "Preferences"), "utf8"), "retained-profile");
  assert.equal(fs.existsSync(join(c.client, "browser")), false);
  await listen(t, join(c.client, "owner.sock"), CLIENT);
  synchronizeRootHands(c);
  assert.equal(fs.statSync(join(c.client, "owner.sock")).ino, fs.statSync(join(c.server, "browser/owner.sock")).ino);
});

test("a retained profile at the common filesystem root is kept beside separate IPC roots", rootOnly, async (t) => {
  const { root, c } = await fixture(t);
  const browserDirectory = fs.realpathSync(root);
  fs.chownSync(browserDirectory, CLIENT.uid, CLIENT.gid);
  const configured = { ...c, browserDirectory };
  fs.writeFileSync(join(browserDirectory, "Preferences"), "retained", { mode: 0o600 });
  fs.chownSync(join(browserDirectory, "Preferences"), CLIENT.uid, CLIENT.gid);
  prepareRootHands(configured);
  assert.equal(fs.readFileSync(join(browserDirectory, "Preferences"), "utf8"), "retained");
  assert.equal(fs.existsSync(join(c.client, "browser")), false);
  await listen(t, join(browserDirectory, "owner.sock"), CLIENT);
  synchronizeRootHands(configured);
  assert.equal(
    fs.statSync(join(browserDirectory, "owner.sock")).ino,
    fs.statSync(join(c.server, "browser/owner.sock")).ino,
  );
  assert.equal(fs.statSync(c.server).uid, 0);
  assert.equal(fs.statSync(c.client).uid, CLIENT.uid);
  assert.throws(() => prepareRootHands({ ...c, browserDirectory: join(browserDirectory, "missing") }));
  assert.equal(fs.existsSync(join(browserDirectory, "missing")), false);
});

// Core validates the composed browser drop against the directories preparation
// creates or retains; a mismatch would otherwise surface only at container start.
function composedOwners(c) {
  const rootBrowserData = join(c.server, "browser");
  const composition = rootHandsOwnerComposition(c, { OPENCRAFT_BROWSER_DATA_DIR: rootBrowserData });
  const privileges = resolveHandsOwnerPrivileges(composition.ownerPrivileges, {
    roles: HANDS_OWNER_PROCESSES.map((owner) => owner.role),
    currentUid: 0,
    environment: { OPENCRAFT_BROWSER_DATA_DIR: composition.browserData },
  });
  const base = {
    env: { OPENCRAFT_BROWSER_DATA_DIR: composition.browserData, XDG_CONFIG_HOME: "/root/.config", KEEP: "1" },
  };
  const options = (role) => {
    const spawned = handsOwnerSpawnOptions(base, privileges[role]);
    return { ...spawned, env: composition.ownerEnvironment(role, spawned.env) };
  };
  return { rootBrowserData, privileges, browser: options("browser"), execution: options("execution") };
}

test("the core browser privilege drop accepts the prepared default layout", rootOnly, async (t) => {
  const { c } = await fixture(t);
  prepareRootHands(c);
  const { rootBrowserData, privileges, browser, execution } = composedOwners(c);
  assert.deepEqual(
    { ...privileges.browser },
    { ...CLIENT, home: c.publicClient, stateDirectory: join(c.publicClient, "browser") },
  );
  assert.equal(browser.uid, CLIENT.uid);
  assert.equal(browser.env.OPENCRAFT_BROWSER_DATA_DIR, join(c.publicClient, "browser"));
  assert.equal(browser.env.HOME, c.publicClient);
  assert.equal(browser.env.XDG_CONFIG_HOME, undefined);
  assert.equal(browser.env.KEEP, "1");
  // Owners that keep root identity see the root-side browser endpoint.
  assert.equal(execution.uid, undefined);
  assert.equal(execution.env.OPENCRAFT_BROWSER_DATA_DIR, rootBrowserData);
  assert.equal(execution.env.XDG_CONFIG_HOME, "/root/.config");
});

test("the core browser privilege drop accepts retained client-root and common-root profiles", rootOnly, async (t) => {
  const legacy = (await fixture(t, { browserName: "." })).c;
  prepareRootHands(legacy);
  assert.equal(composedOwners(legacy).browser.env.OPENCRAFT_BROWSER_DATA_DIR, legacy.publicClient);
  const { root, c } = await fixture(t);
  const browserDirectory = fs.realpathSync(root);
  fs.chownSync(browserDirectory, CLIENT.uid, CLIENT.gid);
  const configured = { ...c, browserDirectory };
  prepareRootHands(configured);
  const { privileges, browser } = composedOwners(configured);
  assert.equal(privileges.browser.stateDirectory, browserDirectory);
  assert.equal(browser.env.HOME, browserDirectory);
});

test("startup prepares the layout, then composes core Hands with the drop and the bridge", rootOnly, async (t) => {
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
  const spawned = [];
  await startRootHands({
    env,
    currentUid: 0,
    spawnProcess: (command, args, options) => spawned.push(options),
    start: async (options) => {
      started = options;
    },
  });
  assert.deepEqual(Object.keys(started.ownerPrivileges), ["browser"]);
  assert.equal(env.OPENCRAFT_BROWSER_DATA_DIR, join(c.publicClient, "browser"));
  assert.ok(fs.existsSync(join(c.client, "terminal.token")));
  assert.equal(fs.statSync(join(workspace, "sessions/codex")).uid, CLIENT.uid);
  started.spawnOwner(
    "node",
    [],
    { env: { OPENCRAFT_BROWSER_DATA_DIR: env.OPENCRAFT_BROWSER_DATA_DIR } },
    { role: "files" },
  );
  assert.equal(spawned[0].env.OPENCRAFT_BROWSER_DATA_DIR, join(c.server, "browser"));
  // The bridge runs as a core service: it publishes sockets and stops Hands on failure.
  let failed = 0;
  const [service] = await started.startServices(() => failed++);
  t.after(() => service.close());
  await listen(t, join(c.server, "terminal.sock"), { uid: 0, gid: 0 });
  await waitFor(() => fs.existsSync(join(c.client, "terminal.sock")));
  fs.writeFileSync(join(c.client, "files.sock"), "not a socket");
  await listen(t, join(c.server, "files.sock"), { uid: 0, gid: 0 });
  await waitFor(() => failed === 1);
});

test("the packaged Hands entry selects root mode only for UID 0", async () => {
  const entry = await readFile(new URL("../../scripts/container-deployment/hands.mjs", import.meta.url), "utf8");
  assert.match(entry, /process\.getuid\?\.\(\) === 0\) await startRootHands\(\)/);
  assert.match(entry, /else await startContainerHands\(\)/);
});

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((accept) => setTimeout(accept, 20));
  }
  assert.fail("condition was not reached");
}
