import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { fileKeyMaterial } from "@opencraft/secret-storage/file";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { HumanAuth } from "@opencraft/access-control/human-auth";
import { MembershipStore, InstanceAccess } from "@opencraft/access-control";
import { HumanAccountManagement } from "@opencraft/access-control/account-management";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { openHumanAssets } from "../../plugins/local-account/src/assets-server.js";
import { openAssetConfigurations } from "../../plugins/assets/src/server/worker.js";
import { humanGitRuntimeDirectory, createHumanGitExecution } from "../../apps/headless-server/src/human-git-execution.js";
import { ThreadIdentityDatabase } from "@opencraft/opencraft-daemon/thread-identity-database";
import { ExecutionLeaseStore, snapshotExecutionSubmission } from "@opencraft/opencraft-daemon/execution-lease-store";
import { observeNativeExecutionProcess } from "@opencraft/opencraft-daemon/native-execution-origin";
import { buildGitIdentityRuntime } from "../../scripts/packaging/package-git-identity-runtime.mjs";
import { githubApiFixture } from "../support/github-api-fixture.js";
import { queryGitIdentityBroker } from "@opencraft/execution-environment/git-identity-ipc";

async function command(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "",
    err = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (err += b));
  const [code] = await once(child, "close");
  return { code, out: out.trim(), err };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "actor-git-execution-")),
    directory = join(root, "data"),
    runtime = join(root, "runtime");
  const storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    accounts = new HumanAccounts(storage, actors),
    members = new MembershipStore(storage);
  const provider = new LocalAccountServerPlugin(accounts.localAccountRepository);
  accounts.registerLocalAccounts(provider);
  const management = new HumanAccountManagement(storage, accounts, actors, members);
  const principal = await management.initialize({
    mode: "web",
    username: "owner",
    password: "Only-synthetic-test-password-42",
  });
  const login = accounts.issue(principal),
    scope = `actor:${login.login.context.actorId}`;
  const config = { origin: "", local: true, oidc: [] };
  const auth = new HumanAuth(accounts, actors, config, () => "<title>Fixture</title>");
  const remote = await githubApiFixture(),
    before = process.env.OPENCRAFT_TEST_GITHUB_ORIGIN;
  process.env.OPENCRAFT_TEST_GITHUB_ORIGIN = remote.origin;
  const access = new InstanceAccess(members, [auth], actors);
  let assets: Awaited<ReturnType<typeof openHumanAssets>>;
  try {
    assets = await openHumanAssets({
      directory,
      actors,
      auth,
      access,
      openStorage: (dir) =>
        openAssetConfigurations(dir, { entry: new URL("../fixtures/assets-git-execution.worker.ts", import.meta.url) }),
    });
  } finally {
    if (before === undefined) delete process.env.OPENCRAFT_TEST_GITHUB_ORIGIN;
    else process.env.OPENCRAFT_TEST_GITHUB_ORIGIN = before;
  }
  const server = createServer((req, res) => {
    void assets.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  config.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (body?: unknown) =>
    fetch(config.origin + "/__opencraft_assets/git-connections", {
      headers: {
        origin: config.origin,
        cookie: `oc_human=${login.token}`,
        "x-opencraft-account-scope": scope,
        "content-type": "application/json",
      },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
  const saved = await request({
    host: "github.com",
    action: "save",
    revision: 0,
    username: "fixture",
    name: "Fixture",
    email: "fixture@example.test",
    token: "synthetic-github-api-token",
  });
  assert.equal(saved.status, 200);
  const metadata = await saved.json();
  const identities = new ThreadIdentityDatabase(join(directory, "thread-identities/opencraft-server")),
    leases = new ExecutionLeaseStore(identities.database);
  const native = await observeNativeExecutionProcess(process.pid),
    threadId = "pi_synthetic",
    inputId = "original-input",
    turnId = "pi_synthetic:turn:client:original-input";
  leases.capture(
    threadId,
    inputId,
    snapshotExecutionSubmission({
      executionPrincipal: principal,
      actorContext: login.login.context,
      validUntil: principal.expiresAt,
    }),
    "accepted",
  );
  const lease = leases.begin(threadId, inputId, native.incarnation);
  leases.started(threadId, turnId, inputId, native.incarnation);
  await buildGitIdentityRuntime(runtime);
  let live = true;
  const authorize = (value: { account: string; actorGeneration?: number }) => {
    const actorId = value.account.slice("actor:".length),
      actor = actors.get(actorId);
    return (
      actor?.enabled === true &&
      actor.kind === "human" &&
      actor.generation === value.actorGeneration &&
      access.admitsActor(actorId)
    );
  };
  const execution = createHumanGitExecution({
    directory,
    runtimeDirectory: join(root, "sockets"),
    workerFile: join(runtime, "personal-git-worker.mjs"),
    hosts: assets.gitHosts,
    authority: assets.gitAuthority!,
    grant: assets.executionGitGrant,
    authorize,
    inspect: async (handoff) =>
      live && handoff.native.incarnation === native.incarnation && handoff.native.turnId === turnId,
  });
  const consumers: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => {
    // Close execution consumers before removing the stores/locks they own.
    for (const close of consumers.reverse()) await close();
    await execution.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await assets.close();
    identities.close();
    management.close();
    auth.close();
    accounts.close();
    members.close();
    actors.close();
    await storage.close();
    await remote.close();
    await rm(root, { recursive: true, force: true });
  });
  const locator = { hostId: "opencraft-server" as const, threadId, inputId };
  const repo = join(root, "repo");
  await mkdir(repo);
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (/^(?:GIT_|OPENCRAFT_GIT_|CODEX_THREAD_ID)/u.test(key)) delete base[key];
  Object.assign(base, {
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  const nativeGit = (...args: string[]) => command("/usr/bin/git", args, repo, base);
  assert.equal((await nativeGit("init", "-q")).code, 0);
  await nativeGit("remote", "add", "origin", "https://github.com/fixture/synthetic.git");
  return {
    root,
    defer(close: () => unknown | Promise<unknown>) { consumers.push(close); },
    repo,
    remote,
    storage,
    principal,
    context: {sender: null, executionPrincipal: principal, actorContext: login.login.context, validUntil: principal.expiresAt},
    access,
    authorize,
    assets,
    actors,
    members,
    scope,
    actorId: login.login.context.actorId,
    leases,
    native,
    lease,
    locator,
    metadata,
    execution,
    request,
    nativeGit,
    base,
    setLive(v: boolean) {
      live = v;
    },
  };
}
test("real Human HTTP save → sole vault Worker → Actor execution handoff → managed Git creates a signed commit", async (t) => {
  const f = await fixture(t),
    handoff = await f.assets.executionGitGrant(f.locator);
  assert.ok(handoff);
  assert.equal(handoff.scope.account, f.scope);
  assert.match(handoff.capability, /^v3\./u);
  assert.ok(Number.isSafeInteger(handoff.scope.actorGeneration));
  assert.equal(handoff.scope.inputId, f.locator.inputId);
  assert.ok(!JSON.stringify(handoff).includes("synthetic-github-api-token"));
  assert.ok(!JSON.stringify(handoff).includes("PRIVATE KEY"));
  const snapshot = await f.execution.prepare(f.locator),
    env = { ...snapshot.apply(f.base), OPENCRAFT_THREAD_ID: f.locator.threadId };
  assert.equal(snapshot.account, f.scope);
  assert.ok(!/v[23]\./u.test(JSON.stringify(snapshot)));
  await writeFile(join(f.repo, "file.txt"), "synthetic\n");
  await f.nativeGit("add", "file.txt");
  const result = await command(join(f.root, "bin/git"), ["commit", "-m", "Synthetic admitted execution"], f.repo, env);
  assert.equal(result.code, 0, result.err);
  assert.equal(
    (await f.nativeGit("log", "-1", "--format=%an|%ae|%cn|%ce")).out,
    "Fixture|fixture@example.test|Fixture|fixture@example.test",
  );
  assert.match((await f.nativeGit("cat-file", "commit", "HEAD")).out, /gpgsig -----BEGIN SSH SIGNATURE-----/);
  const publicKey = f.metadata.hosts["github.com"].signing.publicKey;
  await writeFile(join(f.root, "allowed-signers"), "fixture@example.test " + publicKey + "\n");
  assert.equal(
    (await f.nativeGit("-c", "gpg.ssh.allowedSignersFile=" + join(f.root, "allowed-signers"), "verify-commit", "HEAD"))
      .code,
    0,
  );
  // A stale SQLite active row is not native liveness. The retained environment
  // must fail closed rather than acquire a successor/server identity.
  const before = (await f.nativeGit("rev-parse", "HEAD")).out;
  f.setLive(false);
  await writeFile(join(f.repo, "file.txt"), "changed\n");
  await f.nativeGit("add", "file.txt");
  const stale = await command(join(f.root, "bin/git"), ["commit", "-m", "Must not commit"], f.repo, env);
  assert.notEqual(stale.code, 0);
  assert.equal((await f.nativeGit("rev-parse", "HEAD")).out, before);
  await assert.rejects(f.execution.prepare(f.locator), /unavailable/);
});
test("handoff is not an HTTP action; Actor revocation and unknown/rejected inputs cannot mint execution authority", async (t) => {
  const f = await fixture(t);
  const forged = await f.request({ host: "github.com", revision: 2, action: "executionGitGrant", ...f.locator });
  assert.equal(forged.status, 400);
  await assert.rejects(f.assets.executionGitGrant({ ...f.locator, inputId: "not-original" }));
  await assert.rejects(f.assets.executionGitGrant({ ...f.locator, account: "actor:other" } as any));
  const snapshot = await f.execution.prepare(f.locator),
    env = snapshot.overlay();
  const session = await queryGitIdentityBroker(env.OPENCRAFT_GIT_BROKER_SOCKET!, {
    op: "open",
    threadId: f.locator.threadId,
    host: "github.com",
    operation: "ls-remote",
    capability: env.OPENCRAFT_GIT_CAPABILITY,
  });
  assert.equal(session.status, "configured");
  f.actors.setEnabled(f.actorId, false, "fixture");
  await assert.rejects(f.assets.executionGitGrant(f.locator));
  const credential = await queryGitIdentityBroker(env.OPENCRAFT_GIT_BROKER_SOCKET!, {
    op: "credential",
    sessionId: session.sessionId,
    protocol: "https",
    host: "github.com",
  });
  assert.equal(credential.status, "expired");
});

test('deep Unicode deployment paths retain canonical broker discovery and real signed Git with bounded sockets', async t => {
  const {dirname} = await import('node:path');
  const {stat, readdir} = await import('node:fs/promises');
  const f = await fixture(t), runtimeDirectory = join(f.root, '执行目录'.repeat(20), 'git-runtime');
  const execution = createHumanGitExecution({directory: join(f.root, 'data'), runtimeDirectory,
    workerFile: join(f.root, 'runtime/personal-git-worker.mjs'), hosts: f.assets.gitHosts, authority: f.assets.gitAuthority!,
    grant: f.assets.executionGitGrant, authorize: f.authorize,
    inspect: async grant => grant.native.incarnation === f.native.incarnation,
  }); f.defer(() => execution.close());
  const snapshot = await execution.prepare(f.locator), env = {...snapshot.apply(f.base), OPENCRAFT_THREAD_ID: f.locator.threadId};
  const socket = snapshot.overlay().OPENCRAFT_GIT_BROKER_SOCKET!;
  assert.ok(Buffer.byteLength(socket) <= 100);
  assert.notEqual(dirname(socket), runtimeDirectory);
  assert.ok((await readdir(runtimeDirectory)).some(name => name.startsWith('owner-')));
  // Recovery must discover the short endpoint through the original private
  // metadata/authority, not through a guessed /tmp path or newest socket.
  env.OPENCRAFT_GIT_BROKER_SOCKET = join(f.root, 'absent.sock');
  const commit = await command(join(f.root, 'bin/git'), ['commit', '--allow-empty', '-m', 'DeepUnicodeGit'], f.repo, env);
  assert.equal(commit.code, 0, commit.err);
  await writeFile(join(f.root, 'deep-signers'), 'fixture@example.test ' + f.metadata.hosts['github.com'].signing.publicKey + '\n');
  assert.equal((await f.nativeGit('-c', 'gpg.ssh.allowedSignersFile=' + join(f.root, 'deep-signers'), 'verify-commit', 'HEAD')).code, 0);
  await execution.close();
  await assert.rejects(stat(dirname(socket)), {code: 'ENOENT'});
});

test('exact native Turn resolves its original Human despite a later steer; missing, ended and mixed selectors deny', async t => {
  const f = await fixture(t);
  const turnId = 'pi_synthetic:turn:client:original-input';
  const locator = {hostId: f.locator.hostId, threadId: f.locator.threadId, turnId};
  const before = await f.assets.executionGitGrant(locator);
  assert.equal(before?.scope.inputId, f.locator.inputId);
  const other = f.actors.resolveHuman({provider: 'synthetic-other', subject: 'later', displayName: 'Later', expiresAt: Date.now() + 60000});
  assert.ok(other); f.members.setActor(other.actorId, 'member', true, 'fixture');
  f.leases.capture(f.locator.threadId, 'later-steer', {
    ownership: 'human', principal: {provider: 'synthetic-other', subject: 'later', actorId: other.actorId, actorGeneration: other.generation},
  }, 'accepted', 'steer');
  const after = await f.assets.executionGitGrant(locator);
  assert.deepEqual(after?.scope, before?.scope);
  assert.equal(after?.scope.account, f.scope);
  for (const invalid of [{...locator, inputId: f.locator.inputId}, {...locator, account: f.scope},
    {hostId: locator.hostId, threadId: locator.threadId}, {...locator, turnId: 'unknown'}]) {
    await assert.rejects(f.assets.executionGitGrant(invalid as any));
  }
  f.leases.finished(f.locator.threadId, turnId);
  await assert.rejects(f.assets.executionGitGrant(locator));
});

test('exact native unowned Turn grants no personal identity and never borrows a nearby Human lease', async t => {
  const f = await fixture(t);
  const threadId = 'unowned-native';
  f.leases.begin(threadId, 'internal', f.native.incarnation);
  f.leases.started(threadId, 'dsh-turn-unowned-native-1', 'internal', f.native.incarnation);
  assert.equal(await f.assets.executionGitGrant({hostId: 'opencraft-server', threadId, turnId: 'dsh-turn-unowned-native-1'}), null);
  await assert.rejects(f.assets.executionGitGrant({hostId: 'opencraft-server', threadId, turnId: 'missing'}));
});

async function pendingCodex(t: test.TestContext) {
  const f = await fixture(t);
  const {OpenCraftHostStateDatabase} = await import('../../apps/opencraft-daemon/src/opencraft-host-state-database.js');
  const state = new OpenCraftHostStateDatabase(join(f.root, 'data/codex')); f.defer(() => state.close());
  const leases = new ExecutionLeaseStore(state.database), locator = {hostId: 'local-codex' as const, threadId: 'codex-original', inputId: 'codex-input'};
  leases.capture(locator.threadId, locator.inputId, f.leases.getSubmission(f.locator.threadId, f.locator.inputId)!);
  leases.begin(locator.threadId, locator.inputId, f.native.incarnation);
  const execution = createHumanGitExecution({directory: join(f.root, 'data'), runtimeDirectory: join(f.root, 'codex-sockets'),
    workerFile: join(f.root, 'runtime/personal-git-worker.mjs'), hosts: f.assets.gitHosts, authority: f.assets.gitAuthority!,
    grant: f.assets.executionGitGrant, authorize: f.authorize,
    inspect: async value => value.native.incarnation === f.native.incarnation && value.native.turnId === 'codex-turn',
    reservation: {grant: f.assets.executionGitReservation, inspect: async value => value.native.incarnation === (await observeNativeExecutionProcess(process.pid)).incarnation},
  }); f.defer(() => execution.close());
  return {...f, state, leases, locator, execution};
}

test('Codex configuration reservation cannot open Git until the exact original native lease is active', async t => {
  const f = await pendingCodex(t), reserved = await f.assets.executionGitReservation(f.locator);
  assert.ok(reserved); assert.equal(reserved.scope.account, f.scope);
  assert.deepEqual(reserved.native, {incarnation: f.native.incarnation});
  assert(!JSON.stringify(reserved).includes('synthetic-github-api-token'));
  await assert.rejects(f.assets.executionGitGrant(f.locator));
  const prepared = await f.execution.reserve(f.locator), overlay = prepared.overlay();
  const open = () => queryGitIdentityBroker(overlay.OPENCRAFT_GIT_BROKER_SOCKET!, {op: 'open',
    threadId: f.locator.threadId, host: 'github.com', operation: 'commit', capability: overlay.OPENCRAFT_GIT_CAPABILITY});
  assert.equal((await open()).status, 'expired', 'Readiness is not running command authority');
  f.leases.started(f.locator.threadId, 'codex-turn', f.locator.inputId, f.native.incarnation);
  assert.equal((await open()).status, 'configured', 'The same staged scope becomes usable only after native binding');
  const env = {...prepared.apply(f.base), CODEX_THREAD_ID: f.locator.threadId};
  const result = await command(join(f.root, 'bin/git'), ['commit', '--allow-empty', '-m', 'OriginalCodexReservation'], f.repo, env);
  assert.equal(result.code, 0, result.err);
  await writeFile(join(f.root, 'codex-signers'), 'fixture@example.test ' + f.metadata.hosts['github.com'].signing.publicKey + '\n');
  assert.equal((await f.nativeGit('-c', 'gpg.ssh.allowedSignersFile=' + join(f.root, 'codex-signers'), 'verify-commit', 'HEAD')).code, 0);
  await assert.rejects(f.execution.reserve(f.locator), 'An active execution cannot masquerade as pending setup');
  const before = (await f.nativeGit('rev-parse', 'HEAD')).out;
  f.leases.finished(f.locator.threadId, 'codex-turn');
  assert.equal((await open()).status, 'expired');
  const ended = await command(join(f.root, 'bin/git'), ['commit', '--allow-empty', '-m', 'MustNotReuseEndedReservation'], f.repo, env);
  assert.notEqual(ended.code, 0); assert.equal((await f.nativeGit('rev-parse', 'HEAD')).out, before);
});

test('a logically pending but ended native admission cannot reserve Git configuration', async t => {
  const f = await pendingCodex(t);
  f.state.database.prepare('UPDATE execution_leases SET ended_at_ms=? WHERE thread_id=?').run(Date.now(), f.locator.threadId);
  await assert.rejects(f.assets.executionGitReservation(f.locator));
});

test('pending Git reservation rejects foreign, forged and missing origins and is not a public action', async t => {
  const f = await pendingCodex(t);
  for (const invalid of [{...f.locator, account: f.scope}, {...f.locator, turnId: 'forged'},
    {...f.locator, hostId: 'opencraft-server'}, {...f.locator, inputId: 'missing'}]) {
    await assert.rejects(f.assets.executionGitReservation(invalid as any));
  }
  const publicAttempt = await f.request({host: 'github.com', action: 'executionGitReservation', ...f.locator});
  assert.equal(publicAttempt.status, 400);
  const prepared = await f.execution.reserve(f.locator);
  f.actors.setEnabled(f.actorId, false, "fixture");
  await assert.rejects(f.execution.reserve(f.locator));
  f.leases.started(f.locator.threadId, 'codex-turn', f.locator.inputId, f.native.incarnation);
  assert.equal((await queryGitIdentityBroker(prepared.overlay().OPENCRAFT_GIT_BROKER_SOCKET!, {op: 'open',
    threadId: f.locator.threadId, host: 'github.com', operation: 'commit', capability: prepared.overlay().OPENCRAFT_GIT_CAPABILITY})).status, 'expired');
});

test("disable/enable cycles cannot revive an older Actor execution capability", async (t) => {
  const f = await fixture(t),
    snapshot = await f.execution.prepare(f.locator),
    env = snapshot.overlay();
  f.members.setActor(f.actorId, "member", false, "fixture");
  f.members.setActor(f.actorId, "admin", true, "fixture");
  const open = (value: Record<string, string>) =>
    queryGitIdentityBroker(value.OPENCRAFT_GIT_BROKER_SOCKET!, {
      op: "open",
      threadId: f.locator.threadId,
      host: "github.com",
      operation: "ls-remote",
      capability: value.OPENCRAFT_GIT_CAPABILITY,
    });
  assert.equal((await open(env)).status, "expired");
  const current = await f.execution.prepare(f.locator);
  assert.notEqual(current.key, snapshot.key);
  assert.equal((await open(current.overlay())).status, "configured");
  f.actors.setEnabled(f.actorId, false, "fixture");
  f.actors.setEnabled(f.actorId, true, "fixture");
  assert.equal((await open(current.overlay())).status, "expired");
  await assert.rejects(f.execution.prepare(f.locator), "a new Actor generation needs a newly admitted native input");
});

test("native Pi bash consumes the original admitted input and creates a signed commit through the async Git port", async (t) => {
  const { PiDurableSession } = await import("../../plugins/pi-engine/src/session.js");
  const { createModels } = await import("@earendil-works/pi-ai");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const f = await fixture(t),
    faux = fauxProvider({ tokensPerSecond: 100000 }),
    models = createModels();
  models.setProvider(faux.provider);
  let output = "",
    calls = 0;
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command:
          "printf native-pi > native.txt && git add native.txt && git commit -m NativePiGit && git log -1 --format=%cn",
        yield_time_ms: 1000,
      }),
      { stopReason: "toolUse" },
    ),
    (context: any) => {
      output = JSON.stringify(context.messages);
      return fauxAssistantMessage("done");
    },
  ]);
  const native = await PiDurableSession.open({
    threadId: f.locator.threadId,
    cwd: f.repo,
    file: join(f.root, "native.sqlite"),
    agentDirectory: join(f.root, "agent"),
    models: models as any,
    tools: [],
    executionGit: {
      prepare: async (input) => {
        calls++;
        assert.equal(input.inputId, f.locator.inputId);
        return f.execution.prepare(input);
      },
    },
    onSnapshot() {},
    onTool: async () => {
      throw Error("Unexpected tool");
    },
    onExit: (error) => {
      throw error;
    },
  });
  f.defer(() => native.close());
  await native.configure({ model: { provider: "faux", modelId: "faux-1" }, cwd: f.repo });
  const requestId = "pi_synthetic:turn:client:original-input";
  const admitted = await native.submit(
    "run",
    { turnId: requestId, clientId: f.locator.inputId, input: [{ type: "text", text: "run" }], createdAtMs: Date.now() },
    requestId,
  );
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  await admitted.wait(BACKGROUND_CONTEXT);
  assert.equal(calls, 1);
  assert.match(output, /Fixture/);
  const commit = await f.nativeGit("cat-file", "commit", "HEAD");
  assert.equal(commit.code, 0, output + commit.err);
  assert.match(commit.out, /gpgsig -----BEGIN SSH SIGNATURE-----/);
  assert.match(commit.out, /committer Fixture <fixture@example.test>/);
});

test("retirement during native inspection cannot start an orphan broker after close", async (t) => {
  const f = await fixture(t);
  let reached!: () => void, resume!: () => void;
  const entered = new Promise<void>((r) => (reached = r)),
    gate = new Promise<void>((r) => (resume = r));
  const sockets = join(f.root, "retired-sockets");
  const execution = createHumanGitExecution({
    directory: join(f.root, "data"),
    runtimeDirectory: sockets,
    workerFile: join(f.root, "runtime/personal-git-worker.mjs"),
    hosts: f.assets.gitHosts,
    authority: f.assets.gitAuthority!,
    grant: f.assets.executionGitGrant,
    authorize: f.authorize,
    inspect: async () => {
      reached();
      await gate;
      return true;
    },
  });
  const preparing = execution.prepare(f.locator);
  await entered;
  await execution.close();
  resume();
  await assert.rejects(preparing, /unavailable/);
  await assert.rejects(readFile(join(sockets, "known_hosts")), { code: "ENOENT" });
});

test("a verified legacy binding grant still follows core membership admission without a duplicate Actor-only rule", async (t) => {
  const f = await fixture(t);
  f.storage.database.prepare("DELETE FROM actor_members WHERE actor_id=?").run(f.actorId);
  f.members.set({ provider: f.principal.provider, subject: f.principal.subject }, "member", true, "fixture");
  assert.equal(f.access.admitsActor(f.actorId), true);
  const snapshot = await f.execution.prepare(f.locator);
  assert.equal(snapshot.account, f.scope);
});

test("a held GitHub verification cannot starve a live command authorization read on the sole vault owner", async (t) => {
  const f = await fixture(t),
    snapshot = await f.execution.prepare(f.locator),
    env = snapshot.overlay();
  const pause = f.remote.pause("/user");
  const pending = f.request({
    host: "github.com",
    revision: 2,
    action: "save",
    username: "fixture",
    name: "Renamed",
    email: "fixture@example.test",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let session: any;
  try {
    await pause.entered;
    session = await Promise.race([
      queryGitIdentityBroker(env.OPENCRAFT_GIT_BROKER_SOCKET!, {
        op: "open",
        threadId: f.locator.threadId,
        host: "github.com",
        operation: "ls-remote",
        capability: env.OPENCRAFT_GIT_CAPABILITY,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Execution authorization waited behind remote GitHub IO")), 1500);
      }),
    ]);
    assert.equal(session.status, "configured");
  } finally {
    if (timer) clearTimeout(timer);
    pause.release();
  }
  assert.equal((await pending).status, 200);
  const retired = await queryGitIdentityBroker(env.OPENCRAFT_GIT_BROKER_SOCKET!, {
    op: "credential",
    sessionId: session.sessionId,
    protocol: "https",
    host: "github.com",
  });
  assert.equal(retired.status, "expired", "committed credential rotation still retires the old command revision");
});

test("a provider binding reassignment cannot lend the successor Human credentials to an old native input", async (t) => {
  const f = await fixture(t);
  const other = f.actors.resolveHuman({
    provider: "synthetic-other",
    subject: "second",
    displayName: "Second",
    expiresAt: Date.now() + 60000,
  });
  assert.ok(other);
  f.members.setActor(other.actorId, "member", true, "fixture");
  f.storage.database
    .prepare("UPDATE actor_bindings SET actor_id=? WHERE binding=?")
    .run(other.actorId, JSON.stringify([f.principal.provider, f.principal.subject]));
  await assert.rejects(f.assets.executionGitGrant(f.locator));
});

test("historical leases without captured Actor provenance never acquire today's bound Human credentials", async (t) => {
  const f = await fixture(t);
  f.leases.capture(f.locator.threadId, "legacy-input", {
    principal: { provider: f.principal.provider, subject: f.principal.subject },
    ownership: "human",
  });
  f.leases.begin(f.locator.threadId, "legacy-input", f.native.incarnation);
  f.leases.started(f.locator.threadId, "legacy-turn", "legacy-input", f.native.incarnation);
  await assert.rejects(f.assets.executionGitGrant({ ...f.locator, inputId: "legacy-input" }));
});

async function remoteExecution(t:test.TestContext,f:Awaited<ReturnType<typeof fixture>>) {
 const {SessionCapabilityMcp,capabilitySigningKey}=await import('@opencraft/session-capabilities/mcp');
 const {SessionCapabilities}=await import('@opencraft/session-capabilities');
 const {RemoteSessionCapabilities}=await import('@opencraft/session-capabilities/remote');
 const {createRemoteHumanGitExecution}=await import('../../apps/headless-server/src/remote-human-git-execution.js');
 const directory=join(f.root,'data'),descriptorPath=join(directory,'session-capabilities.json');
 const key=await capabilitySigningKey(fileKeyMaterial(directory));
 let forcedReply:unknown;
 const open=async()=>{
  const gateway=new SessionCapabilityMcp(new SessionCapabilities(),key,undefined,{descriptorPath,retainEndpoint:true,hostGit:async session=>{
   if(session.serverId!=='server:fixture:pi'||session.threadId!==f.locator.threadId||!session.execution?.inputId)throw Error('denied');
   if(forcedReply!==undefined)return forcedReply;
   return {authority:f.assets.gitAuthority,hosts:f.assets.gitHosts,grant:await f.execution.handoff({...f.locator,inputId:session.execution.inputId})};
  }});await gateway.listen();return gateway;
 };
 let gateway=await open();
 const remote=createRemoteHumanGitExecution({directory,runtimeDirectory:join(f.root,'remote-sockets'),workerFile:join(f.root,'runtime/personal-git-worker.mjs'),
  capabilities:new RemoteSessionCapabilities(directory,'server:fixture:pi'),inspect:async grant=>grant.native.incarnation===f.native.incarnation});
 f.defer(async()=>{await remote.close();await gateway.close();});
 return {remote,respond(value:unknown){forcedReply=value;},async restart(){await gateway.close();gateway=await open();},async disconnect(){await gateway.close();}};
}

test('independent native execution receives sealed Git evidence, signs a real commit and rediscovers a restarted Gateway',async t=>{
 const f=await fixture(t),r=await remoteExecution(t,f),snapshot=await r.remote.prepare(f.locator);
 const env={...snapshot.apply(f.base),OPENCRAFT_THREAD_ID:f.locator.threadId};
 await writeFile(join(f.repo,'remote.txt'),'synthetic independent owner\n');await f.nativeGit('add','remote.txt');
 const commit=await command(join(f.root,'bin/git'),['commit','-m','IndependentGit'],f.repo,env);
 assert.equal(commit.code,0,commit.err);
 assert.match((await f.nativeGit('cat-file','commit','HEAD')).out,/gpgsig -----BEGIN SSH SIGNATURE-----/);
 await r.restart();
 const open=()=>queryGitIdentityBroker(env.OPENCRAFT_GIT_BROKER_SOCKET!,{op:'open',threadId:f.locator.threadId,host:'github.com',operation:'ls-remote',capability:env.OPENCRAFT_GIT_CAPABILITY});
 assert.equal((await open()).status,'configured','the retained execution broker reauthorizes at the successor Gateway');
 f.setLive(false);assert.notEqual((await open()).status,'configured','persisted active rows do not replace native liveness');
});

test('independent native authorization fails closed on Gateway loss and membership revocation without opening another writable vault',async t=>{
 const f=await fixture(t),r=await remoteExecution(t,f),snapshot=await r.remote.prepare(f.locator),env=snapshot.overlay();
 const open=()=>queryGitIdentityBroker(env.OPENCRAFT_GIT_BROKER_SOCKET!,{op:'open',threadId:f.locator.threadId,host:'github.com',operation:'ls-remote',capability:env.OPENCRAFT_GIT_CAPABILITY});
 const session=await open();assert.equal(session.status,'configured');
 await r.disconnect();assert.notEqual((await open()).status,'configured');
 await r.restart();assert.equal((await open()).status,'configured');
 f.members.setActor(f.actorId,'member',false,'fixture');
 assert.notEqual((await open()).status,'configured');
 const credential=await queryGitIdentityBroker(env.OPENCRAFT_GIT_BROKER_SOCKET!,{op:'credential',sessionId:session.sessionId,protocol:'https',host:'github.com'});
 assert.notEqual(credential.status,'configured');assert.ok(!JSON.stringify(credential).includes('synthetic-github-api-token'));
 await assert.rejects(r.remote.prepare(f.locator));
});

test('real independent Pi owner consumes the Server handoff at its bash boundary and never opens a writable vault',async t=>{
 const {startIndependentEngineHost}=await import('../../scripts/server-deployment/engine-host.mjs');
 const {ModelConfigurationRepository}=await import('../../apps/local-agent-host/src/model-config/repository.js');
 const {piModel}=await import('../../plugins/pi-engine/src/index.js');
 const {SessionCapabilities}=await import('@opencraft/session-capabilities');
 const {SessionCapabilityMcp,capabilitySigningKey}=await import('@opencraft/session-capabilities/mcp');
 const {createNativeExecutionTurnInspector}=await import('@opencraft/opencraft-daemon/native-execution-inspector');
 const f=await fixture(t),directory=join(f.root,'data');
 let requests=0;
 const model=createServer(async(req,res)=>{
  for await(const _chunk of req) { /* Consume only synthetic model input. */ }
  const first=++requests===1;
  const delta=first?{role:'assistant',tool_calls:[{index:0,id:'native-git',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'printf independent-native > independent.txt && git add independent.txt && git commit -m IndependentNativePiGit',yield_time_ms:1000})}}]}:{role:'assistant',content:'done'};
  const chunk=(value:unknown,finish:unknown)=>'data: '+JSON.stringify({id:'synthetic-'+requests,object:'chat.completion.chunk',choices:[{index:0,delta:value,finish_reason:finish}]})+'\n\n';
  res.writeHead(200,{'content-type':'text/event-stream'});res.write(chunk(delta,null));res.end(chunk({},first?'tool_calls':'stop')+'data: [DONE]\n\n');
 });model.listen(0,'127.0.0.1');await once(model,'listening');
 f.defer(async()=>{model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));});
 await new ModelConfigurationRepository(fileStateDocumentStore(join(directory,'models'))).initialize({schemaVersion:1,revision:0,
  defaultModel:{providerId:'synthetic',modelId:'synthetic'},providers:[{id:'synthetic',name:'Synthetic',protocol:'openai-completions',credentialRef:null,authentication:'none',baseUrl:`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`,enabled:true,
  models:[{id:'synthetic',name:'Synthetic',enabled:true,input:['text'],contextWindow:64000,maxTokens:1000,reasoningEfforts:false}]}]});
 const descriptorPath=join(f.root,'native-host.json');
 const host=await startIndependentEngineHost({descriptorPath,dataDirectory:directory,runtimeDirectory:f.repo,engines:['pi'],defaultEngine:'pi',executionContext:'assets',gitWorkerFile:join(f.root,'runtime/personal-git-worker.mjs')});
 f.defer(()=>host.close());
 const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
 const client={notify(){},async request(){throw Error('Unexpected client tool');}};
 const inspect=createNativeExecutionTurnInspector((method,params)=>host.pi.request(method,params,client));
 const issuer=createHumanGitExecution({directory,runtimeDirectory:join(f.root,'unused-gateway-broker'),workerFile:join(f.root,'runtime/personal-git-worker.mjs'),hosts:f.assets.gitHosts,authority:f.assets.gitAuthority!,grant:f.assets.executionGitGrant,authorize:f.authorize,
  inspect:async handoff=>handoff.native.incarnation===f.native.incarnation&&await inspect({threadId:handoff.scope.threadId,turnId:handoff.native.turnId,engineIncarnation:handoff.native.incarnation} as any)==='active'});
 f.defer(()=>issuer.close());
 const key=await capabilitySigningKey(fileKeyMaterial(directory));
 const gateway=new SessionCapabilityMcp(new SessionCapabilities(),key,undefined,{descriptorPath:join(directory,'session-capabilities.json'),hostGit:async session=>{
  if(session.serverId!==`server:${descriptor.machineId}:pi`||!session.execution?.inputId)throw Error('denied');
  return {authority:f.assets.gitAuthority,hosts:f.assets.gitHosts,grant:await issuer.handoff({hostId:'opencraft-server',threadId:session.threadId,inputId:session.execution.inputId})};
 }});await gateway.listen();f.defer(()=>gateway.close());
 const {thread}=await host.pi.request('thread/start',{model:piModel('synthetic','synthetic'),cwd:f.repo},client);
 const inputId='independent-original';
 f.leases.capture(thread.id,inputId,f.leases.getSubmission(f.locator.threadId,f.locator.inputId)!);
 f.leases.begin(thread.id,inputId,f.native.incarnation);
 let stop=()=>{};
 const done=new Promise<any>((resolve,reject)=>{
  const timer=setTimeout(()=>{stop();reject(Error('Independent native Pi did not settle'));},30000);
  stop=host.pi.subscribe((method,params)=>{if(method==='turn/completed'&&params.threadId===thread.id){clearTimeout(timer);stop();resolve(params.turn);}});
 });
 const started=await host.pi.request('turn/start',{threadId:thread.id,clientUserMessageId:inputId,input:[{type:'text',text:'Create a synthetic signed commit.'}]},client);
 f.leases.started(thread.id,started.turn.id,inputId,f.native.incarnation);
 assert.equal((await done).status,'completed');
 assert.equal((await f.nativeGit('log','-1','--format=%s')).out,'IndependentNativePiGit');
 assert.match((await f.nativeGit('cat-file','commit','HEAD')).out,/gpgsig -----BEGIN SSH SIGNATURE-----/);
 await writeFile(join(f.root,'independent-allowed-signers'),'fixture@example.test '+f.metadata.hosts['github.com'].signing.publicKey+'\n');
 assert.equal((await f.nativeGit('-c','gpg.ssh.allowedSignersFile='+join(f.root,'independent-allowed-signers'),'verify-commit','HEAD')).code,0);
 assert.equal(requests,2);
 await assert.rejects(issuer.handoff({hostId:'opencraft-server',threadId:thread.id,inputId}),'completed native state overrides a stale active lease');
});


test('pinned DSH foreground/background and persistent PTY sign through original Actor admission; later turns cannot borrow its terminal',
 {skip: !process.env.OPENCRAFT_DSH_RUNTIME}, async t => {
  const {dshGitRuntime, dshGitContext} = await import('../support/dsh-git-runtime.mjs');
  const {registerDshExecutionEnvironment} = await import('../../apps/local-agent-host/src/dsh-execution-environment.mjs');
  const {SessionCapabilityMcp, capabilitySigningKey} = await import('@opencraft/session-capabilities/mcp');
  const {SessionCapabilities} = await import('@opencraft/session-capabilities');
  const {RemoteSessionCapabilities} = await import('@opencraft/session-capabilities/remote');
  const {createRemoteHumanGitExecution} = await import('@opencraft/execution-environment/remote-human-git-execution');
  const sdk = await dshGitRuntime(t), f = await fixture(t), directory = join(f.root, 'data');
  const threadId = 'dsh-public', inputId = 'original-dsh-input', turnId = `dsh-turn-${threadId}-7`;
  f.leases.capture(threadId, inputId, f.leases.getSubmission(f.locator.threadId, f.locator.inputId)!);
  f.leases.begin(threadId, inputId, f.native.incarnation); f.leases.started(threadId, turnId, inputId, f.native.incarnation);
  const agent = {id: 'native-dsh', status: 'running', session: {header: {id: 'native-dsh'}, events: [
    {type: 'turn/start', data: {turn: 7}}, {type: 'user/message', data: {source: {rpcId: 'original'}}},
    {type: 'user/message', data: {source: {rpcId: 'unrelated-steer'}}},
  ]}, ctx: undefined as any};
  const issuer = createHumanGitExecution({directory, runtimeDirectory: join(f.root, 'unused-issuer'),
    workerFile: join(f.root, 'runtime/personal-git-worker.mjs'), hosts: f.assets.gitHosts, authority: f.assets.gitAuthority!,
    grant: f.assets.executionGitGrant, authorize: f.authorize,
    inspect: async grant => grant.native.incarnation === f.native.incarnation && grant.native.turnId === turnId && agent.status === 'running'
      && agent.session.events.filter(e => e.type === 'turn/start' || e.type === 'turn/end').at(-1)?.type === 'turn/start',
  }); f.defer(() => issuer.close());
  const key = await capabilitySigningKey(fileKeyMaterial(directory));
  const gateway = new SessionCapabilityMcp(new SessionCapabilities(), key, undefined, {
    descriptorPath: join(directory, 'session-capabilities.json'), hostGit: async session => {
      if (session.serverId !== 'server:fixture:dsh' || session.threadId !== threadId || !session.execution) throw Error('denied');
      return {authority: f.assets.gitAuthority, hosts: f.assets.gitHosts, grant: await issuer.handoff({hostId: 'opencraft-server', threadId,
        ...(session.execution.inputId ? {inputId: session.execution.inputId} : {turnId: session.execution.turnId!})})};
    },
  }); await gateway.listen(); f.defer(() => gateway.close());
  const remote = createRemoteHumanGitExecution({directory, runtimeDirectory: join(f.root, 'dsh-sockets'),
    workerFile: join(f.root, 'runtime/personal-git-worker.mjs'), capabilities: new RemoteSessionCapabilities(directory, 'server:fixture:dsh'),
    inspect: async grant => grant.native.incarnation === f.native.incarnation,
  }); f.defer(() => remote.close());
  let port: any;
  const host = dshGitContext(sdk, f.repo, () => port); f.defer(() => host.close());
  agent.ctx = host.ctx;
  Object.assign(host.ctx, {agents: new Map([[agent.id, agent]]), provide(_name: string, value: unknown) {port = value;}, inject() {}});
  registerDshExecutionEnvironment(host.ctx, () => threadId, undefined, remote);
  const exec = {agent, signal: new AbortController().signal};
  const git = JSON.stringify(join(f.root, 'bin/git'));
  const args = (message: string) => ({command: `${git} commit --allow-empty -m ${message}`, description: 'Create synthetic signed commit', workdir: f.repo});
  const foreground = await host.tool.execute(args('DshForeground'), exec);
  assert.equal(foreground.exitCode, 0, foreground.stderr.text);
  assert.equal((await host.tool.execute({...args('DshBackground'), run_in_background: true}, exec)).kind, 'background');
  await host.jobs[0].done;
  assert.equal(host.jobs[0].readOutput().includes('[exit code:'), false);
  assert.equal((await f.nativeGit('log', '-1', '--format=%s')).out, 'DshBackground');
  const backend = new sdk.terminal.BashTerminalBackend(host.ctx, {
    backendType: 'shell', shellDialect: 'bash', shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc', '-i'],
    rows: 24, cols: 100, scrollbackLines: 1000, scrollbackMaxBytes: 65536, maxReadBytes: 65536,
    pollIntervalMs: 20, exactProbeAfterMs: 100, idleSilenceMs: 300, handoffGraceMs: 50, timeoutMs: 5000, disposeGraceMs: 100,
  });
  const terminal = await backend.spawn({owner: agent, sessionId: 'synthetic-pty', cwd: f.repo, signal: exec.signal});
  f.defer(() => terminal.close('fixture teardown'));
  await terminal.startSend({text: args('DshTerminal').command, submit: true}).done;
  assert.equal((await f.nativeGit('log', '-1', '--format=%s')).out, 'DshTerminal');
  await writeFile(join(f.root, 'dsh-signers'), 'fixture@example.test ' + f.metadata.hosts['github.com'].signing.publicKey + '\n');
  for (const commit of ['HEAD', 'HEAD~1', 'HEAD~2']) {
    assert.equal((await f.nativeGit('-c', 'gpg.ssh.allowedSignersFile=' + join(f.root, 'dsh-signers'), 'verify-commit', commit)).code, 0);
  }
  // A persistent shell retains its original provenance. Ending that Turn must
  // revoke Git even if another Human later sends commands to the same Agent.
  const before = (await f.nativeGit('rev-parse', 'HEAD')).out;
  agent.session.events.push({type: 'turn/end', data: {turn: 7}}); f.leases.finished(threadId, turnId);
  await terminal.startSend({text: args('MustNotBorrowNextTurn').command, submit: true}).done;
  assert.equal((await f.nativeGit('rev-parse', 'HEAD')).out, before);
  await assert.rejects(host.tool.execute(args('EndedTurnDenied'), exec));
});


test('real independent DSH process consumes the compiled Assets handoff without a writable credential vault',
 {skip: !process.env.OPENCRAFT_DSH_RUNTIME, timeout: 90000}, async t => {
  const {cp, stat, readdir, readlink} = await import('node:fs/promises');
  const {fileURLToPath} = await import('node:url');
  const {WebSocket} = await import('ws');
  const {startLocalAgentHost} = await import('../../apps/local-agent-host/src/main.js');
  const {ModelConfigurationRepository} = await import('../../apps/local-agent-host/src/model-config/repository.js');
  const {readHostMachineIdentity} = await import('../../apps/local-agent-host/src/machine-identity.js');
  const {SessionCapabilityMcp, capabilitySigningKey} = await import('@opencraft/session-capabilities/mcp');
  const {SessionCapabilities} = await import('@opencraft/session-capabilities');
  const {createWebSocketExecutionTurnInspector} = await import('@opencraft/opencraft-daemon/native-execution-inspector');
  const {patchDshGitExecution} = await import('../../scripts/postinstall/patch-dsh-git-execution.mjs');
  const f = await fixture(t), runtime = join(f.root, 'pinned-dsh'), directory = join(f.root, 'data');
  const vaultPath = join(directory, 'employee-git-vault.sqlite'), originalVault = await stat(vaultPath);
  await mkdir(runtime);
  await cp(join(process.env.OPENCRAFT_DSH_RUNTIME!, 'node_modules'), join(runtime, 'node_modules'), {recursive: true});
  for (const name of ['package.json', 'package-lock.json']) await cp(join(process.env.OPENCRAFT_DSH_RUNTIME!, name), join(runtime, name));
  await patchDshGitExecution(runtime);
  let requests = 0;
  const endpoint = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const withTools = Array.isArray(body.tools) && body.tools.length > 0;
    const first = withTools && !JSON.stringify(body.messages).includes('tool_call_id');
    if (withTools) requests++;
    const delta = first ? {role: 'assistant', tool_calls: [{index: 0, id: 'dsh-native-git', type: 'function', function: {
      name: 'bash', arguments: JSON.stringify({command: JSON.stringify(join(f.root, 'bin/git')) + ' commit --allow-empty -m IndependentNativeDshGit', description: 'Create synthetic signed Git commit'}),
    }}]} : {role: 'assistant', content: 'Synthetic complete'};
    res.writeHead(200, {'content-type': 'text/event-stream'});
    const emit = (delta: unknown, finish_reason: unknown) => res.write('data: ' + JSON.stringify({id: 'synthetic', object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason}]}) + '\n\n');
    emit(delta, null); emit({}, first ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  }); endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  f.defer(async () => {endpoint.closeAllConnections(); await new Promise<void>(r => endpoint.close(() => r()));});
  const models = join(f.root, 'models');
  await new ModelConfigurationRepository(fileStateDocumentStore(models)).initialize({schemaVersion: 1, revision: 0, defaultModel: {providerId: 'synthetic', modelId: 'synthetic'},
    providers: [{id: 'synthetic', name: 'Synthetic', protocol: 'openai-completions', authentication: 'none', credentialRef: null, enabled: true,
      baseUrl: `http://127.0.0.1:${(endpoint.address() as {port: number}).port}/v1`, models: [{id: 'synthetic', name: 'Synthetic', enabled: true, input: ['text'], contextWindow: 64000, maxTokens: 1000, reasoningEfforts: false}]}]});
  const machine = await readHostMachineIdentity(directory);
  const host = await startLocalAgentHost({dataDirectory: join(f.root, 'host'), modelStorageDirectory: models, machineIdentity: machine,
    skillsDirectory: join(f.root, 'skills'), dshExecutable: join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    dshCapabilityPlugin: fileURLToPath(new URL('../../apps/local-agent-host/src/dsh-capability-plugin.mjs', import.meta.url)),
    executionContext: 'assets', gitExecution: {directory, machineId: machine.machineId, workerFile: join(f.root, 'runtime/personal-git-worker.mjs')},
  }); f.defer(() => host.close());
  const inspector = await createWebSocketExecutionTurnInspector(async () => host.websocketUrl); f.defer(() => inspector.close());
  const issuer = createHumanGitExecution({directory, runtimeDirectory: join(f.root, 'unused-dsh-issuer'), hosts: f.assets.gitHosts, authority: f.assets.gitAuthority!,
    workerFile: join(f.root, 'runtime/personal-git-worker.mjs'), grant: f.assets.executionGitGrant, authorize: f.authorize,
    inspect: async grant => {
      if (!host.engineProcessId || (await observeNativeExecutionProcess(host.engineProcessId)).incarnation !== grant.native.incarnation) return false;
      return await inspector.inspect({threadId: grant.scope.threadId, turnId: grant.native.turnId, engineIncarnation: grant.native.incarnation} as any) === 'active';
    },
  }); f.defer(() => issuer.close());
  const key = await capabilitySigningKey(fileKeyMaterial(directory));
  const gateway = new SessionCapabilityMcp(new SessionCapabilities(), key, undefined, {descriptorPath: join(directory, 'session-capabilities.json'), hostGit: async session => {
    if (session.serverId !== `server:${machine.machineId}:dsh` || !session.execution) throw Error('denied');
    return {authority: f.assets.gitAuthority, hosts: f.assets.gitHosts, grant: await issuer.handoff({hostId: 'opencraft-server', threadId: session.threadId,
      ...(session.execution.inputId ? {inputId: session.execution.inputId} : {turnId: session.execution.turnId!})})};
  }}); await gateway.listen(); f.defer(() => gateway.close());
  const socket = new WebSocket(host.websocketUrl), pending = new Map<string, {resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}>();
  const completed = Promise.withResolvers<any>(); let sequence = 0, threadId = '', incarnation = '';
  f.defer(() => {socket.terminate(); for (const entry of pending.values()) {clearTimeout(entry.timer); entry.reject(Error('fixture closed'));}});
  socket.on('message', raw => {
    const frame = JSON.parse(String(raw)), entry = pending.get(String(frame.id));
    if (entry) {clearTimeout(entry.timer); pending.delete(String(frame.id)); frame.error ? entry.reject(Error(frame.error.message)) : entry.resolve(frame.result);}
    if (frame.method === 'turn/started' && frame.params.threadId === threadId) f.leases.started(threadId, frame.params.turn.id, 'original-dsh-process', incarnation);
    if (frame.method === 'turn/completed' && frame.params.threadId === threadId) completed.resolve(frame.params.turn);
  }); await once(socket, 'open');
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = `fixture-${++sequence}`, timer = setTimeout(() => {pending.delete(id); reject(Error('Native DSH request timed out: ' + method));}, 15000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
  await call('initialize', {clientInfo: {name: 'synthetic-git', version: '1'}, capabilities: {}});
  const model = (await call('model/list')).data[0].model;
  // Explicit permission for this synthetic Git transport fixture, not a
  // production default or a fallback from a selected confinement backend.
  threadId = (await call('thread/start', {model, cwd: f.repo, permissions: 'danger-full-access'})).thread.id;
  assert.ok(host.engineProcessId); incarnation = (await observeNativeExecutionProcess(host.engineProcessId!)).incarnation;
  f.leases.capture(threadId, 'original-dsh-process', f.leases.getSubmission(f.locator.threadId, f.locator.inputId)!);
  f.leases.begin(threadId, 'original-dsh-process', incarnation);
  await call('turn/start', {threadId, model, clientUserMessageId: 'original-dsh-process', input: [{type: 'text', text: 'Create a synthetic signed Git commit.'}]});
  const turn = await Promise.race([completed.promise, new Promise<never>((_, reject) => {const timeout = setTimeout(() => reject(Error('Native DSH did not complete')), 25000); timeout.unref();})]);
  assert.equal(turn.status, 'completed');
  assert.equal((await f.nativeGit('log', '-1', '--format=%s')).out, 'IndependentNativeDshGit',
    JSON.stringify((await call('thread/read', {threadId, includeTurns: true})).thread.turns));
  assert.equal(requests, 2);
  await writeFile(join(f.root, 'native-dsh-signers'), 'fixture@example.test ' + f.metadata.hosts['github.com'].signing.publicKey + '\n');
  assert.equal((await f.nativeGit('-c', 'gpg.ssh.allowedSignersFile=' + join(f.root, 'native-dsh-signers'), 'verify-commit', 'HEAD')).code, 0);
  await assert.rejects(issuer.handoff({hostId: 'opencraft-server', threadId, inputId: 'original-dsh-process'}));
  // The sole Assets Worker already owns this vault. DSH may hold its read-only
  // replica, never a second writable connection or a new per-Host vault.
  assert.equal((await stat(vaultPath)).ino, originalVault.ino);
  await assert.rejects(stat(join(f.root, 'host/employee-git-vault.sqlite')), {code: 'ENOENT'});
  let replicas = 0;
  for (const fd of await readdir(`/proc/${host.engineProcessId}/fd`)) {
    const target = await readlink(`/proc/${host.engineProcessId}/fd/${fd}`).catch(() => null);
    if (target !== vaultPath) continue;
    const info = await readFile(`/proc/${host.engineProcessId}/fdinfo/${fd}`, 'utf8');
    const flags = /^flags:\s+([0-7]+)$/mu.exec(info); assert.ok(flags);
    assert.equal(parseInt(flags[1]!, 8) & 3, 0, 'Native broker must only open the existing vault read-only');
    replicas++;
  }
  assert.ok(replicas > 0, 'Inspect the actual independent native broker, not just an absent file');
});

test('retiring an independent handoff aborts its pending read and cannot create a broker afterwards',async()=>{
 const {createRemoteHumanGitExecution}=await import('../../apps/headless-server/src/remote-human-git-execution.js');
 let entered!:()=>void,resume!:()=>void,signal:AbortSignal|undefined;
 const reached=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>resume=r);
 const execution=createRemoteHumanGitExecution({directory:'/not-opened',runtimeDirectory:'/not-opened',workerFile:'/not-opened',inspect:async()=>true,
  capabilities:{async hostGit(_thread,_input,s){signal=s;entered();await gate;return {authority:'a'.repeat(64),hosts:['github.com'],grant:null};}}});
 const preparing=execution.prepare({hostId:'opencraft-server',threadId:'original',inputId:'input'});
 await reached;await execution.close();assert.equal(signal?.aborted,true);resume();
 await assert.rejects(preparing,/git_execution_unavailable/);
});


test('explicit anonymous installation has no personal Git authority and is not confused with unavailable admission',async()=>{
 const {createRemoteHumanGitExecution}=await import('../../apps/headless-server/src/remote-human-git-execution.js');
 let response:unknown={mode:'anonymous'};
 const execution=createRemoteHumanGitExecution({directory:'/not-opened',runtimeDirectory:'/not-opened',workerFile:'/not-opened',inspect:async()=>true,capabilities:{async hostGit(){return response;}}});
 const input={hostId:'opencraft-server' as const,threadId:'native',inputId:'original'};
 try {
  assert.deepEqual((await execution.prepare(input)).overlay(),{});
  for(response of [null,{}, {mode:'anonymous',account:'forged'}])await assert.rejects(execution.prepare(input));
 }finally{await execution.close();}
});


test('an independent broker that pinned an Actor authority never downgrades to anonymous mode',async t=>{
 const f=await fixture(t),r=await remoteExecution(t,f);
 const snapshot=await r.remote.prepare(f.locator),env=snapshot.overlay();
 r.respond({mode:'anonymous'});
 await assert.rejects(r.remote.prepare(f.locator));
 const result=await queryGitIdentityBroker(env.OPENCRAFT_GIT_BROKER_SOCKET!,{op:'open',threadId:f.locator.threadId,host:'github.com',operation:'ls-remote',capability:env.OPENCRAFT_GIT_CAPABILITY});
 assert.notEqual(result.status,'configured');
});


// Opt-in installed stock-native boundary, synthetic model and account only.
for (const replaceGateway of [false, true]) test(`stock independent Codex signs from the original Assets admission (Gateway replacement=${replaceGateway})`, {
  skip: !process.env.OPENCRAFT_TEST_NATIVE_CLI,
  timeout: 60000,
}, async t => {
  const f = await fixture(t);
  const {startCodexCore} = await import('../../apps/codex-core/src/main.js');
  const {decodeResponsesRequestBody} = await import('../../packages/account-pool-host/src/configured-forward.js');
  const {CodexEngineAdapter} = await import('../../apps/opencraft-daemon/src/codex-engine-adapter.js');
  const {LOGICAL_CLIENT_FIELD} = await import('@opencraft/app-host-protocol');
  const {CodexCoreControlClient} = await import('@opencraft/account-pool-host');
  const token = 'synthetic-git-core-owner-token-'.repeat(3), dataDirectory = join(f.root, 'data/codex');
  let modelPosts = 0;
  let releaseModel!: () => void;
  const modelGate = new Promise<void>(resolve => {releaseModel = resolve;});
  const requested = Promise.withResolvers<void>(), reattached = Promise.withResolvers<void>();
  let prepared: {apply(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv} | undefined;
  const bounded = <T>(value: Promise<T>) => Promise.race([value, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(Error('Native Git lifecycle fixture did not settle')), 8000); timer.unref();
  })]);
  const toolOutputs: string[] = [];
  const core = await startCodexCore({
    endpoint: join(f.root, 'core.sock'), authToken: token,
    executable: process.env.OPENCRAFT_TEST_NATIVE_CLI!, runtimeDirectory: f.repo,
    dataDirectory, nativeCodexHomeDirectory: join(f.root, 'native-codex'),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (init?.method !== 'POST' || !url.pathname.endsWith('/responses')) return Response.json({plan_type: 'pro'});
      modelPosts++;
      const raw = typeof init.body === 'string' ? Buffer.from(init.body) : new Uint8Array(init.body as Uint8Array);
      const decoded = await decodeResponsesRequestBody(new Headers(init.headers).get('content-encoding'), raw);
      if (decoded instanceof Response) return decoded;
      const body = JSON.parse(Buffer.from(decoded).toString('utf8'));
      for (const item of body.input ?? []) if (item.type === 'function_call_output') toolOutputs.push(String(item.output));
      const tools = (body.tools ?? []).map((value: any) => value.name ?? value.function?.name);
      let item: any;
      if (modelPosts === 1) {
        requested.resolve(); if (replaceGateway) await modelGate;
        assert.ok(tools.includes('exec_command'), 'The stock native tool surface must provide exec_command: ' + tools.join(','));
        item = {type: 'function_call', id: 'fc_native_git', call_id: 'call_native_git', name: 'exec_command',
          arguments: JSON.stringify({cmd: 'git commit --allow-empty -m NativeCodexAssets', workdir: f.repo, yield_time_ms: 1000, max_output_tokens: 1000}), status: 'completed'};
      } else {
        assert.ok(modelPosts <= 2, 'No model request retry or accidental new Turn');
        item = {type: 'message', id: 'msg_native_git', role: 'assistant', status: 'completed',
          content: [{type: 'output_text', text: 'Synthetic native Git completed.', annotations: []}]};
      }
      const response = {id: 'resp_native_git_' + modelPosts, object: 'response', status: 'in_progress', output: []};
      const events = [{type: 'response.created', response},
        {type: 'response.output_item.added', output_index: 0, item: {...item, status: 'in_progress'}},
        {type: 'response.output_item.done', output_index: 0, item},
        {type: 'response.completed', response: {...response, status: 'completed', output: [item],
          usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}}];
      return new Response(events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), {headers: {'content-type': 'text/event-stream'}});
    },
  }); f.defer(() => core.close()); f.defer(() => releaseModel());
  const control = new CodexCoreControlClient(core.endpoint, token), before = await control.health();
  const makeEngine = () => new CodexEngineAdapter({executable: process.env.OPENCRAFT_TEST_NATIVE_CLI!, runtimeDirectory: f.repo,
    dataDirectory, nativeCodexHomeDirectory: join(f.root, 'native-codex'), coreEndpoint: core.endpoint, coreAuthToken: token, coreHostOverlays: true,
    logDiagnostic() {},
    createExecutionGit: native => {
      const execution = createHumanGitExecution({directory: join(f.root, 'data'), runtimeDirectory: join(f.root, 'codex-ipc'),
        workerFile: join(f.root, 'runtime/personal-git-worker.mjs'), hosts: f.assets.gitHosts, authority: f.assets.gitAuthority!,
        grant: f.assets.executionGitGrant, inspect: native.inspect, authorize: f.authorize,
        reservation: {grant: f.assets.executionGitReservation, inspect: native.inspectReservation}});
      return {...execution,
        async reserve(input) {const snapshot = await execution.reserve(input); prepared = snapshot; return snapshot;},
        async prepare(input) {const snapshot = await execution.prepare(input); assert.equal(snapshot.account, f.scope); reattached.resolve(); return snapshot;},
      };
    },
  });
  const frames: any[] = [];
  let engine = makeEngine(); f.defer(() => engine.close());
  const connect = async () => {engine.subscribeMessage(frame => frames.push(JSON.parse(frame))); await engine.connect();};
  await connect();
  let sequence = 0;
  const rpc = async (method: string, params: object = {}, original = false) => {
    const id = ++sequence, frame = JSON.stringify({id, method, params, [LOGICAL_CLIENT_FIELD]: 'native-git'});
    if (original) await engine.sendWithContext(frame, f.context); else await engine.send(frame);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const reply = frames.find(value => value.id === id && !value.method && value[LOGICAL_CLIENT_FIELD] === 'native-git');
      if (reply) {if (reply.error) throw Error(method + ': ' + reply.error.message); return reply.result;}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('Timed out awaiting native Git fixture ' + method);
  };
  await rpc('initialize', {clientInfo: {name: 'synthetic-native-git', version: '1'}, capabilities: {experimentalApi: true}});
  await mkdir(join(f.root, 'native-codex'), {recursive: true});
  const access = Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {chatgpt_account_id: 'synthetic-git-account'}})).toString('base64url') + '.synthetic';
  await writeFile(join(f.root, 'native-codex/auth.json'), JSON.stringify({auth_mode: 'chatgpt',
    tokens: {access_token: access, refresh_token: 'synthetic', account_id: 'synthetic-git-account'}}));
  await rpc('opencraft/codex/accounts/import');
  // Deliberate fixture permission, not a product default or sandbox fallback.
  const {thread} = await rpc('thread/start', {cwd: f.repo, ephemeral: false, model: 'gpt-5.3-codex', sandbox: 'danger-full-access', approvalPolicy: 'never'});
  const started = await rpc('turn/start', {threadId: thread.id, model: 'gpt-5.3-codex', clientUserMessageId: 'original-native-codex',
    input: [{type: 'text', text: 'Create the synthetic signed Git commit.'}]}, true);
  await bounded(requested.promise);
  assert.ok(prepared);
  const originalEnvironment = prepared;
  if (replaceGateway) {
    await engine.close();
    assert.equal((await control.health()).codexPid, before.codexPid);
    engine = makeEngine(); await connect();
    await rpc('initialize', {clientInfo: {name: 'synthetic-replacement', version: '1'}, capabilities: {experimentalApi: true}});
    await bounded(reattached.promise);
    releaseModel();
  }
  const deadline = Date.now() + 20000;
  let status: string | undefined;
  while (Date.now() < deadline) {
    const latest = (await rpc('thread/turns/list', {threadId: thread.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded'})).data?.[0];
    if (latest?.id === started.turn.id) status = latest.status;
    if (status === 'completed' || status === 'failed' || status === 'interrupted') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(status, 'completed');
  assert.equal((await f.nativeGit('log', '-1', '--format=%s')).out, 'NativeCodexAssets', toolOutputs.join('\n'));
  assert.equal(modelPosts, 2);
  await writeFile(join(f.root, 'native-codex-signers'), 'fixture@example.test ' + f.metadata.hosts['github.com'].signing.publicKey + '\n');
  assert.equal((await f.nativeGit('-c', 'gpg.ssh.allowedSignersFile=' + join(f.root, 'native-codex-signers'), 'verify-commit', 'HEAD')).code, 0);
  assert.equal((await control.health()).codexPid, before.codexPid, 'The existing native owner executes Git; no replacement executor');
  const beforeEndedAttempt = (await f.nativeGit('rev-parse', 'HEAD')).out;
  const ended = await command(join(f.root, 'bin/git'), ['commit', '--allow-empty', '-m', 'MustNotReuseFinishedNativeCodex'], f.repo,
    {...originalEnvironment.apply(f.base), CODEX_THREAD_ID: thread.id});
  assert.notEqual(ended.code, 0, 'A persisted lease is not enough after Native completion');
  assert.equal((await f.nativeGit('rev-parse', 'HEAD')).out, beforeEndedAttempt);
});


test('Assets Git uses the configured shared IPC mount without a container-private fallback or observer mixing', () => {
  const directories = new Set<string>();
  for (const owner of ['gateway', 'codex', 'pi', 'dsh'] as const) {
    assert.equal(humanGitRuntimeDirectory('/tmp/local-git', owner, '/var/lib/opencraft/git-credentials'), '/var/lib/opencraft/git-credentials/' + owner);
    directories.add(humanGitRuntimeDirectory('/tmp/local-git', owner, '/run/ocg'));
    for (const invalid of ['', 'relative/path', '/tmp/invalid\0directory'])
      assert.throws(() => humanGitRuntimeDirectory('/tmp/local-git', owner, invalid), /git_ipc_directory_unavailable/);
    assert.throws(() => humanGitRuntimeDirectory('/tmp/local-git', owner, '/tmp/' + '目录'.repeat(40)), /git_shared_ipc_directory_too_long/);
  }
  assert.equal(directories.size, 4, 'Each native observer owns its own broker discovery namespace');
});
