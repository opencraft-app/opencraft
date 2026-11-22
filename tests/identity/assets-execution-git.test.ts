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

async function remoteExecution(t:test.TestContext,f:Awaited<ReturnType<typeof fixture>>) {
 const {SessionCapabilityMcp,capabilitySigningKey}=await import('@opencraft/session-capabilities/mcp');
 const {SessionCapabilities}=await import('@opencraft/session-capabilities');
 const {RemoteSessionCapabilities}=await import('@opencraft/session-capabilities/remote');
 const {createRemoteHumanGitExecution}=await import('../../apps/headless-server/src/remote-human-git-execution.js');
 const directory=join(f.root,'data'),descriptorPath=join(directory,'session-capabilities.json');
 const key=await capabilitySigningKey(join(directory,'session-capabilities.key'));
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
 t.after(async()=>{await remote.close();await gateway.close();});
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
 t.after(async()=>{model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));});
 await new ModelConfigurationRepository(join(directory,'models')).initialize({schemaVersion:1,revision:0,
  defaultModel:{providerId:'synthetic',modelId:'synthetic'},providers:[{id:'synthetic',name:'Synthetic',protocol:'openai-completions',credentialRef:null,authentication:'none',baseUrl:`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`,enabled:true,
  models:[{id:'synthetic',name:'Synthetic',enabled:true,input:['text'],contextWindow:64000,maxTokens:1000,reasoningEfforts:false}]}]});
 const descriptorPath=join(f.root,'native-host.json');
 const host=await startIndependentEngineHost({descriptorPath,dataDirectory:directory,runtimeDirectory:f.repo,engines:['pi'],defaultEngine:'pi',executionContext:'assets',gitWorkerFile:join(f.root,'runtime/personal-git-worker.mjs')});
 t.after(()=>host.close());
 const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
 const client={notify(){},async request(){throw Error('Unexpected client tool');}};
 const inspect=createNativeExecutionTurnInspector((method,params)=>host.pi.request(method,params,client));
 const issuer=createHumanGitExecution({directory,runtimeDirectory:join(f.root,'unused-gateway-broker'),workerFile:join(f.root,'runtime/personal-git-worker.mjs'),hosts:f.assets.gitHosts,authority:f.assets.gitAuthority!,grant:f.assets.executionGitGrant,authorize:f.authorize,
  inspect:async handoff=>handoff.native.incarnation===f.native.incarnation&&await inspect({threadId:handoff.scope.threadId,turnId:handoff.native.turnId,engineIncarnation:handoff.native.incarnation} as any)==='active'});
 t.after(()=>issuer.close());
 const key=await capabilitySigningKey(join(directory,'session-capabilities.key'));
 const gateway=new SessionCapabilityMcp(new SessionCapabilities(),key,undefined,{descriptorPath:join(directory,'session-capabilities.json'),hostGit:async session=>{
  if(session.serverId!==`server:${descriptor.machineId}:pi`||!session.execution?.inputId)throw Error('denied');
  return {authority:f.assets.gitAuthority,hosts:f.assets.gitHosts,grant:await issuer.handoff({hostId:'opencraft-server',threadId:session.threadId,inputId:session.execution.inputId})};
 }});await gateway.listen();t.after(()=>gateway.close());
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
