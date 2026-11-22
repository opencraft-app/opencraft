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
import { createHumanGitExecution } from "../../apps/headless-server/src/human-git-execution.js";
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
  t.after(async () => {
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
    repo,
    remote,
    storage,
    principal,
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
  t.after(() => native.close());
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
