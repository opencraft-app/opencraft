import test from "node:test";
import assert from "node:assert/strict";
import { connect, createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { MembershipStore } from "@opencraft/access-control";
import { HumanAccountManagement } from "@opencraft/access-control/account-management";
import { TERMINAL_RESOURCE_LIMITS } from "@opencraft/appserver-protocol";
import {
  EnvironmentLaunchIssuer,
  EnvironmentLaunchReceiver,
  type EnvironmentLaunchContextV2,
  type EnvironmentLaunchTarget,
} from "@opencraft/execution-environment/environment-delivery";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { AccountEnvironment } from "@opencraft/execution-environment/account-environment";
import { ExecutionEnvironmentRuntime, environmentProjectId } from "@opencraft/execution-environment";
import {
  EnvironmentLaunchOwner,
  environmentTerminalRecords,
} from "@opencraft/execution-environment/environment-launch-owner";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { openHeadlessAssetsStorage } from "../../apps/headless-server/src/headless-assets-storage.js";
import {
  createHandsTerminalService,
  type HostTerminalEnvironmentLaunch,
} from "../../apps/headless-server/src/host-terminal-transport.js";
import { TerminalCapacityError } from "../../apps/local-agent-host/src/process-identity.js";
import { startTerminalPtyOwner } from "../../apps/local-agent-host/src/terminal-pty-owner.js";
import { createTerminalEnvironmentLaunch } from "../../apps/local-agent-host/src/terminal-environment-launch.js";
import {
  readOwnerFrames,
  sendOwnerFrame,
  TERMINAL_OWNER_PROTOCOL,
} from "../../apps/local-agent-host/src/terminal-owner-wire.js";
import { startHandsTerminal } from "../../scripts/container-deployment/terminal.mjs";
import { deploymentPaths } from "../../scripts/container-deployment/paths.mjs";

const SECRET = "synthetic-terminal-only-value";
const PROJECT_VALUE = "synthetic-terminal-project-value";
const GLOBAL_VALUE = "synthetic-terminal-global-value";
const ALICE = "actor:human://fixture/alice";
const shell = ["/bin/bash", "--noprofile", "--norc"];
const output = (snapshot: any) =>
  (snapshot.output ?? []).map((entry: any) => Buffer.from(entry.deltaBase64, "base64").toString()).join("");
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error("Terminal ENV test timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const scopeOf = (account: string, threadId: string | null = "thread", hostId = "opencraft-server") => ({
  account,
  actorId: account.slice("actor:".length),
  hostId,
  threadId,
  projectId: null,
});

/** The independent Hands terminal owner, as the container deployment starts it. */
async function hands(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "oc-term-env-"));
  const paths = deploymentPaths({
    OPENCRAFT_DATA_DIR: join(root, "state"),
    OPENCRAFT_WORKSPACE_DIR: join(root, "work"),
  });
  await mkdir(paths.runtimeDirectory, { recursive: true });
  const stop = await startHandsTerminal(paths, { verify: false });
  const closers: Array<() => unknown> = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  const journal = async () =>
    JSON.parse(await readFile(join(paths.terminalDirectory, "terminal-admission.json"), "utf8"));
  const spawn = (processHandle: string, extra: Record<string, unknown> = {}) => ({
    processHandle,
    cwd: paths.runtimeDirectory,
    command: shell,
    tty: true,
    size: { cols: 80, rows: 24 },
    threadId: "thread",
    ...extra,
  });
  return { root, paths, journal, spawn, cleanup: (close: () => unknown) => closers.push(close) };
}
type Hands = Awaited<ReturnType<typeof hands>>;
/** Records every byte Main writes to the terminal owner. */
async function recordingProxy(h: Hands) {
  const endpoint = join(h.root, "proxy.sock"),
    sent: Buffer[] = [],
    sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(h.paths.terminalEndpoint);
    sockets.add(client).add(upstream);
    client.on("data", (bytes) => {
      sent.push(Buffer.from(bytes));
      upstream.write(bytes);
    });
    upstream.on("data", (bytes) => client.write(bytes));
    for (const [a, b] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      a.on("error", () => {});
      a.on("close", () => b.destroy());
    }
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  h.cleanup(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { endpoint, sent: () => Buffer.concat(sent).toString() };
}
/** A port backed by a plain issuer, for owner-side refusals. */
function port(values: Record<string, string> = { SERVICE_KEY: SECRET }) {
  const issuer = new EnvironmentLaunchIssuer();
  const sealed: string[] = [];
  const value: HostTerminalEnvironmentLaunch = {
    issuer: issuer.key,
    async seal(target, context) {
      const capsule = issuer.seal(
        target,
        context,
        () => values,
        () => {},
      );
      sealed.push(capsule);
      return capsule;
    },
    async terminalActor(account) {
      return { account, actorGeneration: 1, membershipRevision: 0 };
    },
  };
  return { issuer, value, sealed };
}

/** Real Actor store, as the Gateway writes it. */
async function actors(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "term-env-owner-")),
    directory = join(root, "data");
  const storage = await openServerDatabase(directory),
    store = new ActorStore(storage),
    accounts = new HumanAccounts(storage, store),
    members = new MembershipStore(storage);
  accounts.registerLocalAccounts(new LocalAccountServerPlugin(accounts.localAccountRepository));
  const management = new HumanAccountManagement(storage, accounts, store, members);
  const principal = await management.initialize({
    mode: "web",
    username: "owner",
    password: "Only-synthetic-test-password-42",
  });
  const login = accounts.issue(principal);
  t.after(async () => {
    management.close();
    accounts.close();
    members.close();
    store.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  const account = `actor:${login.login.context.actorId}`;
  const vault = new EmployeeGitVaultStore(directory);
  try {
    const environment = new AccountEnvironment(vault);
    environment.replace(account, { projectId: null }, 0, [
      { name: "SERVICE_KEY", value: SECRET, secret: true },
      { name: "SHARED", value: GLOBAL_VALUE, secret: false },
    ]);
    environment.replace(account, { projectId: environmentProjectId("opencraft-server", "alpha") }, 0, [
      { name: "SHARED", value: PROJECT_VALUE, secret: true },
    ]);
    new ExecutionEnvironmentRuntime(directory, vault, false, "disabled").bind("opencraft-server", "thread", "alpha");
  } finally {
    vault.close();
  }
  return { directory, account };
}

test("prepare forwards only an opaque capsule; the terminal owner opens it under its own reservation", async (t) => {
  const f = await actors(t);
  const seen: string[] = [];
  const emit = Worker.prototype.emit;
  Worker.prototype.emit = function (this: Worker, event: string | symbol, ...args: unknown[]) {
    if (event === "message") seen.push(JSON.stringify(args[0]) ?? "");
    return emit.call(this, event, ...args);
  } as typeof emit;
  t.after(() => {
    Worker.prototype.emit = emit;
  });
  const assets = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  t.after(() => assets.close());
  const launch = assets.environmentLaunch as unknown as HostTerminalEnvironmentLaunch;
  assert.equal(typeof launch.terminalActor, "function", "the core vault owner admits terminal launches");
  assert.equal(await launch.terminalActor("actor:human://fixture/nobody"), null);
  const h = await hands(t),
    proxy = await recordingProxy(h);
  const service = createHandsTerminalService({
    directory: h.paths.terminalDirectory,
    endpoint: proxy.endpoint,
    tokenFile: h.paths.terminalToken,
    environmentLaunch: launch,
  });
  h.cleanup(() => service.close());
  const scope = scopeOf(f.account);
  await service.dispatch("process/spawn", h.spawn("delivered", { env: { EXTRA: "requested-visible" } }), scope);
  await service.dispatch(
    "process/writeStdin",
    {
      processHandle: "delivered",
      deltaBase64: Buffer.from('printf \'KEY=%s SHARED=%s EXTRA=%s\\n\' "$SERVICE_KEY" "$SHARED" "$EXTRA"\n').toString(
        "base64",
      ),
    },
    scope,
  );
  await until(
    () => service.dispatch("process/attach", { processHandle: "delivered", afterSequence: 0 }, scope),
    (value) => output(value).includes(`KEY=${SECRET} SHARED=${PROJECT_VALUE} EXTRA=requested-visible`),
  );
  // A threadless terminal never takes a Project from the request.
  const threadless = { ...scopeOf(f.account, null), projectId: "alpha" };
  await service.dispatch("process/spawn", h.spawn("threadless", { threadId: null, projectId: "alpha" }), threadless);
  await service.dispatch(
    "process/writeStdin",
    { processHandle: "threadless", deltaBase64: Buffer.from("printf 'SHARED=%s\\n' \"$SHARED\"\n").toString("base64") },
    threadless,
  );
  await until(
    () => service.dispatch("process/attach", { processHandle: "threadless", afterSequence: 0 }, threadless),
    (value) => output(value).includes(`SHARED=${GLOBAL_VALUE}`),
  );
  const mainToOwner = proxy.sent();
  assert.match(mainToOwner, /"capsule":"env2\./u, "Main forwarded the capsule");
  assert.match(mainToOwner, /"environmentIssuer":"/u);
  for (const value of [SECRET, PROJECT_VALUE, GLOBAL_VALUE]) {
    assert.ok(!mainToOwner.includes(value), "no value in any Main message to the terminal owner");
    for (const message of seen) assert.ok(!message.includes(value), "no value in any Worker message to Main");
  }
  // Launching took the held admission out of the journal before spawn.
  const journal = await h.journal();
  assert.equal(journal.version, 1);
  assert.equal(journal.reservations.length, 2);
  // A revoked Actor gets no launch, and nothing stays reserved.
  await assert.rejects(
    service.dispatch("process/spawn", h.spawn("stranger"), scopeOf("actor:human://fixture/nobody")),
    /environment_launch_unavailable/,
  );
  assert.equal((await h.journal()).reservations.length, 2);
});

/** A raw authenticated Host attachment, to send what a faulty or hostile relay could. */
async function attach(h: Hands, issuer?: string) {
  const token = (await readFile(h.paths.terminalToken, "utf8")).trim();
  const socket = connect(h.paths.terminalEndpoint);
  h.cleanup(() => socket.destroy());
  const pending = new Map<number, (value: any) => void>();
  let next = 0;
  const attached = new Promise<any>((resolve, reject) => {
    socket.once("error", reject);
    readOwnerFrames(socket, (message) => {
      if (message.type) resolve(message);
      else pending.get(message.id)?.(message);
    });
  });
  socket.once("connect", () =>
    sendOwnerFrame(socket, {
      type: "attach",
      protocol: TERMINAL_OWNER_PROTOCOL,
      token,
      ...(issuer ? { environmentIssuer: issuer } : {}),
    }),
  );
  const hello = await attached;
  const call = (method: string, params: unknown, identity: unknown) =>
    new Promise<any>((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      sendOwnerFrame(socket, { id, method, params, identity });
    });
  return { hello, call, close: () => socket.destroy() };
}

test("replay, unheld, launched, abandoned and mismatched admissions never open", async (t) => {
  const h = await hands(t);
  const { issuer } = port();
  const scope = scopeOf(ALICE);
  const identity = { owner: "alice-owner", quotaOwner: "alice-quota", scope };
  const epoch = {
    account: ALICE,
    actorGeneration: 1,
    membershipRevision: 0,
    hostId: "opencraft-server",
    threadId: "thread",
  };
  const host = await attach(h, issuer.key);
  assert.equal(host.hello.environmentLaunch, 1);
  const reserve = async (handle: string) => {
    const reply = await host.call("process/environmentReserve", { processHandle: handle, admission: epoch }, identity);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    return reply.result as { admission: EnvironmentLaunchContextV2["admission"]; target: EnvironmentLaunchTarget };
  };
  const seal = (target: EnvironmentLaunchTarget, admission: any) =>
    issuer.seal(
      target,
      { version: 2, admission },
      () => ({ SERVICE_KEY: SECRET }),
      () => {},
    );
  const spawn = (via: typeof host, handle: string, launch: unknown, extra: object = {}) =>
    via.call("process/spawn", h.spawn(handle), {
      ...identity,
      env: {},
      ...(launch === undefined ? {} : { launch }),
      ...extra,
    });
  const relayed = (admission: any, capsule: string) => ({ context: { version: 2, admission }, capsule });

  const a = await reserve("a");
  assert.equal(a.target.purpose, "terminal");
  assert.equal(a.admission.kind, "terminal");
  assert.equal(a.admission.resource, a.admission.incarnation, "a local reservation is keyed by the owner incarnation");
  const capsule = seal(a.target, a.admission);
  assert.deepEqual((await spawn(host, "a", relayed(a.admission, capsule))).result, { processHandle: "a" });
  // Replay of the same capsule, and a fresh capsule for the launched admission
  // through a NEW attachment (no in-memory one-shot set): the journal refuses.
  assert.ok((await spawn(host, "a", relayed(a.admission, capsule))).error);
  const second = await attach(h, issuer.key);
  const probe = await second.call("process/environmentReserve", { processHandle: "probe", admission: epoch }, identity);
  await second.call("process/environmentAbandon", { processHandle: "probe" }, identity);
  const fresh = await spawn(second, "a", relayed(a.admission, seal(probe.result.target, a.admission)));
  assert.ok(fresh.error, "an already launched reservation is not admissible");
  // Never reserved.
  const never = { ...a.admission, operation: "never" };
  assert.ok((await spawn(host, "never", relayed(never, seal(a.target, never)))).error);
  // Abandoned before launch.
  const b = await reserve("b");
  await host.call("process/environmentAbandon", { processHandle: "b" }, identity);
  assert.ok((await spawn(host, "b", relayed(b.admission, seal(b.target, b.admission)))).error);
  // Wrong kind, stale epoch, other recipient and a v1 (wrong purpose) capsule.
  const c = await reserve("c");
  const creation = {
    kind: "creation",
    account: ALICE,
    actorGeneration: 1,
    membershipRevision: 0,
    hostId: "opencraft-server",
    operationId: "c",
    source: null,
    incarnation: c.admission.incarnation,
  };
  assert.ok(
    (await spawn(host, "c", { context: { version: 2, admission: creation }, capsule: seal(c.target, c.admission) }))
      .error,
  );
  const d = await reserve("d");
  const stale = { ...d.admission, actorGeneration: 2 };
  assert.ok((await spawn(host, "d", relayed(stale, seal(d.target, stale)))).error);
  const e = await reserve("e");
  const other = new EnvironmentLaunchReceiver({
    purpose: "terminal",
    instance: "other",
    issuer: issuer.key,
    authorize: async () => {},
  });
  assert.ok((await spawn(host, "e", relayed(e.admission, seal(other.target, e.admission)))).error);
  other.close();
  const g = await reserve("g");
  const v1 = issuer.seal(
    { ...g.target, purpose: "dsh" },
    {
      scope: {
        account: ALICE,
        hostId: "opencraft-server",
        threadId: "thread",
        inputId: "input",
        executionId: "execution",
        leaseGeneration: 1,
        actorGeneration: 1,
        membershipRevision: 0,
        projectId: null,
      },
      native: { turnId: "turn", incarnation: g.admission.incarnation },
    },
    () => ({ SERVICE_KEY: SECRET }),
    () => {},
  );
  assert.ok((await spawn(host, "g", relayed(g.admission, v1))).error);
  // Another quota owner cannot launch Alice's reservation.
  const k = await reserve("k");
  assert.ok(
    (await spawn(host, "k", relayed(k.admission, seal(k.target, k.admission)), { quotaOwner: "mallory" })).error,
  );
  // A delivery attachment never spawns without a capsule; a plain one never with.
  const l = await reserve("l");
  assert.ok((await spawn(host, "l", undefined)).error);
  const plain = await attach(h);
  assert.equal(plain.hello.environmentLaunch, undefined);
  assert.ok((await spawn(plain, "m", relayed(l.admission, seal(l.target, l.admission)))).error);
  assert.ok((await plain.call("process/environmentReserve", { processHandle: "m", admission: epoch }, identity)).error);
  // Every refused attempt released its reservation; only the launch holds capacity.
  const journal = await h.journal();
  assert.equal(journal.version, 1);
  assert.deepEqual(
    journal.reservations.map((row: { operation: string }) => row.operation),
    ["a"],
  );
  // A bad issuer pin is refused at attach.
  const bad = await attach(h, "not-a-key");
  assert.equal(bad.hello.type, "incompatible");
});

test("a reservation held past its window, or by a closed attachment, is released", async () => {
  const rows = new Map<string, any>();
  const journal = {
    async reserve(_kind: "local", quotaOwner: string, _resource: string, operation: string, launch: any) {
      rows.set(operation, { quotaOwner, launch });
      return "receipt";
    },
    async held(_resource: string, operation: string) {
      return rows.get(operation) ?? null;
    },
    async launch() {
      return "receipt";
    },
    async abandon(_resource: string, operation: string) {
      return rows.delete(operation);
    },
  };
  const { issuer } = port();
  const owner = createTerminalEnvironmentLaunch({
    journal,
    incarnation: "i",
    issuer: issuer.key,
    instance: "x",
    holdMs: 30,
  });
  const identity = {
    quotaOwner: "q",
    scope: { account: ALICE, hostId: "opencraft-server", threadId: null, projectId: null },
  };
  const claim = {
    account: ALICE,
    actorGeneration: 1,
    membershipRevision: 0,
    hostId: "opencraft-server",
    threadId: null,
  };
  await owner.reserve(identity, { processHandle: "late", admission: claim });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(rows.has("late"), false, "an unlaunched hold expires");
  await owner.reserve(identity, { processHandle: "open", admission: claim });
  await assert.rejects(
    owner.reserve(identity, { processHandle: "other", admission: { ...claim, account: "actor:human://fixture/bob" } }),
  );
  await owner.close();
  assert.equal(rows.size, 0, "closing the attachment releases what it still holds");
  await assert.rejects(owner.reserve(identity, { processHandle: "after", admission: claim }));
});

test("attach, list and control keep their scope; capacity and managed names hold with delivery", async (t) => {
  const h = await hands(t);
  const { value } = port({ SERVICE_KEY: SECRET, SHARED: GLOBAL_VALUE });
  const service = createHandsTerminalService({
    directory: h.paths.terminalDirectory,
    endpoint: h.paths.terminalEndpoint,
    tokenFile: h.paths.terminalToken,
    environmentLaunch: value,
  });
  h.cleanup(() => service.close());
  const alice = scopeOf(ALICE),
    bob = scopeOf("actor:human://fixture/bob");
  await service.dispatch("process/spawn", h.spawn("scoped"), alice);
  assert.equal(((await service.dispatch("process/list", {}, scopeOf(ALICE, null))) as any).processes.length, 1);
  assert.equal(((await service.dispatch("process/list", {}, bob)) as any).processes.length, 0);
  assert.equal(((await service.dispatch("process/list", {}, scopeOf(ALICE, "other"))) as any).processes.length, 0);
  await assert.rejects(service.dispatch("process/attach", { processHandle: "scoped", afterSequence: 0 }, bob));
  await assert.rejects(
    service.dispatch("process/attach", { processHandle: "scoped", afterSequence: 0 }, scopeOf(ALICE, "other")),
  );
  await assert.rejects(
    service.dispatch("process/kill", { processHandle: "scoped" }, scopeOf(ALICE, "thread", "local-codex")),
  );
  await assert.rejects(service.dispatch("process/writeStdin", { processHandle: "scoped", deltaBase64: "" }, bob));
  await service.dispatch("process/resizePty", { processHandle: "scoped", size: { cols: 90, rows: 30 } }, alice);
  // A requested name cannot shadow a delivered one; the reservation is released.
  await assert.rejects(service.dispatch("process/spawn", h.spawn("override", { env: { SERVICE_KEY: "x" } }), alice));
  await assert.rejects(
    service.dispatch("process/spawn", h.spawn("reserved", { env: { NODE_OPTIONS: "--import x" } }), alice),
  );
  assert.ok(
    !(await h.journal()).reservations.some((row: { operation: string }) => row.operation === "override"),
    "a refused launch releases its reservation",
  );
  // Handles are fresh per spawn; one admission opens at most once per attachment.
  await service.dispatch("process/spawn", h.spawn("override-2", { env: { OTHER: "y" } }), alice);
  // Capacity: the reservation counts before anything is sealed.
  const carol = scopeOf("actor:human://fixture/carol");
  for (let i = 0; i < TERMINAL_RESOURCE_LIMITS.activePerAccountHost; i++)
    await service.dispatch("process/spawn", h.spawn(`carol-${i}`, { command: ["/bin/cat"] }), carol);
  await assert.rejects(
    service.dispatch("process/spawn", h.spawn("carol-over", { command: ["/bin/cat"] }), carol),
    (error) => error instanceof TerminalCapacityError,
  );
  for (let i = 0; i < TERMINAL_RESOURCE_LIMITS.activePerAccountHost; i++)
    await service.dispatch("process/kill", { processHandle: `carol-${i}` }, carol);
  const journal = await h.journal();
  assert.equal(journal.version, 1);
  assert.ok(journal.reservations.every((row: object) => !Object.hasOwn(row, "launch")));
});

test("without delivery the synchronous path is unchanged, and a delivery Host refuses an owner that cannot receive", async (t) => {
  const h = await hands(t);
  const plain = createHandsTerminalService({
    directory: h.paths.terminalDirectory,
    endpoint: h.paths.terminalEndpoint,
    tokenFile: h.paths.terminalToken,
  });
  h.cleanup(() => plain.close());
  const alice = scopeOf(ALICE);
  await plain.dispatch("process/spawn", h.spawn("plain", { env: { PLAIN: "requested" } }), alice);
  await plain.dispatch(
    "process/writeStdin",
    {
      processHandle: "plain",
      deltaBase64: Buffer.from('printf \'PLAIN=%s KEY=%s\\n\' "$PLAIN" "$SERVICE_KEY"\n').toString("base64"),
    },
    alice,
  );
  await until(
    () => plain.dispatch("process/attach", { processHandle: "plain", afterSequence: 0 }, alice),
    (value) => /PLAIN=requested KEY=\r?\n/u.test(output(value)),
  );
  assert.deepEqual(Object.keys((await h.journal()).reservations[0]).sort(), [
    "kind",
    "operation",
    "quotaOwner",
    "resource",
    "token",
  ]);
  assert.equal((await h.journal()).version, 1);
  // An owner that did not opt in never confirms the pinned issuer.
  const directory = join(h.root, "local-owner"),
    endpoint = join(h.root, "local.sock");
  await mkdir(directory, { mode: 0o700 });
  const token = (await readFile(h.paths.terminalToken, "utf8")).trim();
  const stop = await startTerminalPtyOwner(directory, endpoint, { token });
  h.cleanup(stop);
  const { value } = port();
  const delivery = createHandsTerminalService({
    directory,
    endpoint,
    tokenFile: h.paths.terminalToken,
    environmentLaunch: value,
  });
  h.cleanup(() => delivery.close());
  await assert.rejects(delivery.dispatch("process/spawn", h.spawn("refused"), alice), /upgrade/);
  assert.equal(((await delivery.dispatch("process/list", {}, alice)) as any).processes.length, 0);
  assert.throws(
    () =>
      createHandsTerminalService({
        directory,
        endpoint,
        tokenFile: h.paths.terminalToken,
        environmentLaunch: value,
        environment: {} as never,
      }),
    /One terminal ENV owner/,
  );
});

test("the vault owner seals a terminal claim only under the current Actor epoch, with the Thread's Project", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "term-env-issuer-"));
  const vault = new EmployeeGitVaultStore(directory);
  t.after(async () => {
    vault.close();
    await rm(directory, { recursive: true, force: true });
  });
  const environment = new AccountEnvironment(vault);
  environment.replace(ALICE, { projectId: null }, 0, [{ name: "SHARED", value: GLOBAL_VALUE, secret: false }]);
  environment.replace(ALICE, { projectId: environmentProjectId("opencraft-server", "alpha") }, 0, [
    { name: "SHARED", value: PROJECT_VALUE, secret: true },
  ]);
  new ExecutionEnvironmentRuntime(directory, vault, false, "disabled").bind("opencraft-server", "thread", "alpha");
  let epoch: { account: string; actorGeneration: number; membershipRevision: number } | null = {
    account: ALICE,
    actorGeneration: 1,
    membershipRevision: 0,
  };
  let reads = 0;
  const owner = new EnvironmentLaunchOwner(vault, () => null, {
    terminal: environmentTerminalRecords(vault, (account) => {
      reads++;
      return epoch && account === epoch.account ? epoch : null;
    }),
  });
  t.after(() => owner.close());
  const claim = {
    kind: "terminal" as const,
    account: ALICE,
    actorGeneration: 1,
    membershipRevision: 0,
    hostId: "opencraft-server" as const,
    threadId: "thread",
    resource: "incarnation",
    operation: "handle",
    incarnation: "incarnation",
  };
  const open = async (admission: typeof claim) => {
    const receiver = new EnvironmentLaunchReceiver({
      purpose: "terminal",
      instance: "x",
      issuer: owner.issuer,
      authorize: async () => {},
    });
    try {
      return await receiver.open(owner.seal(receiver.target, { version: 2, admission }), { version: 2, admission });
    } finally {
      receiver.close();
    }
  };
  assert.equal((await open(claim)).apply({}).SHARED, PROJECT_VALUE, "the Thread binding selects the Project");
  assert.equal((await open({ ...claim, threadId: null } as never)).apply({}).SHARED, GLOBAL_VALUE);
  const refused = /environment_launch_unavailable/u;
  await assert.rejects(open({ ...claim, actorGeneration: 2 }), refused);
  await assert.rejects(open({ ...claim, membershipRevision: 1 }), refused);
  // The epoch changing while sealing refuses.
  const flip = new EnvironmentLaunchOwner(vault, () => null, {
    terminal: environmentTerminalRecords(vault, (account) => ({
      account,
      actorGeneration: reads++ % 2 ? 2 : 1,
      membershipRevision: 0,
    })),
  });
  const receiver = new EnvironmentLaunchReceiver({
    purpose: "terminal",
    instance: "x",
    issuer: flip.issuer,
    authorize: async () => {},
  });
  assert.throws(() => flip.seal(receiver.target, { version: 2, admission: claim }), refused);
  receiver.close();
  flip.close();
  epoch = null;
  await assert.rejects(open(claim), refused, "a revoked Actor gets nothing");
});
