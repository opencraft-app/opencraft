import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvironmentLaunchIssuer,
  type EnvironmentLaunchContext,
  type EnvironmentLaunchTarget,
} from "@opencraft/execution-environment/environment-delivery";
import { createRemoteEnvironmentLaunch } from "@opencraft/execution-environment/remote-environment-launch";
import type { GitExecutionHandoff } from "@opencraft/execution-environment/git-execution";
import { SessionCapabilityMcp, capabilitySigningKey } from "@opencraft/session-capabilities/mcp";
import { SessionCapabilities } from "@opencraft/session-capabilities";
import { RemoteSessionCapabilities } from "@opencraft/session-capabilities/remote";
import { hostEnvironmentToken, hostGitToken } from "../../packages/session-capabilities/src/credentials.js";
import { createHostEnvironmentLaunch } from "../../apps/headless-server/src/host-environment-launch.ts";
import { registerDshExecutionEnvironment } from "../../apps/local-agent-host/src/dsh-execution-environment.mjs";
import { validateHeadlessIdentity } from "../../apps/headless-server/src/headless-identity.mjs";

const SECRET = "synthetic-vault-only-value";
const threadId = "dsh-public",
  turnId = `dsh-turn-${threadId}-7`,
  attachment = "server:fixture:dsh";
const admitted = (): GitExecutionHandoff => ({
  scope: {
    account: "actor:human://fixture/one",
    hostId: "opencraft-server",
    threadId,
    inputId: "original-input",
    executionId: "original-execution",
    leaseGeneration: 1,
    actorGeneration: 1,
    membershipRevision: 0,
    projectId: null,
  },
  authority: "a".repeat(64),
  capability: "v3.synthetic",
  native: { turnId, incarnation: "native-original" },
});
const contextOf = (h: GitExecutionHandoff): EnvironmentLaunchContext => ({ scope: h.scope, native: h.native });
/** The execution owner's own durable admission: never read from the relay. */
const ownerAdmission = (state: { owned: EnvironmentLaunchContext | null; incarnation: string }) => async () => {
  const owned = state.owned;
  if (owned && owned.native.incarnation !== state.incarnation) throw Error("admission names another process");
  return owned && structuredClone(owned);
};

/** Real loopback Gateway relay + a vault-owner port using the real issuer. The
 * Gateway callback never receives values; it only relays the capsule. */
async function fixture(t: test.TestContext, serverId = attachment) {
  const directory = await mkdtemp(join(tmpdir(), "env-launch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = await capabilitySigningKey(join(directory, "session-capabilities.key"));
  const vault = new EnvironmentLaunchIssuer();
  const state = {
    lease: admitted() as GitExecutionHandoff | null,
    owned: contextOf(admitted()) as EnvironmentLaunchContext | null,
    incarnation: "native-original",
    values: { SERVICE_KEY: SECRET } as Record<string, string>,
    afterSeal: () => {},
    replay: undefined as unknown,
    relayed: [] as string[],
    reads: 0,
  };
  const port = {
    issuer: vault.key,
    async seal(target: EnvironmentLaunchTarget, context: EnvironmentLaunchContext) {
      const capsule = vault.seal(
        target,
        context,
        () => {
          state.reads++;
          return state.values;
        },
        () => {},
      );
      state.afterSeal();
      return capsule;
    },
  };
  const relay = createHostEnvironmentLaunch({
    port,
    handoff: async (locator) =>
      state.lease &&
      locator.threadId === state.lease.scope.threadId &&
      (locator.turnId ?? state.lease.native.turnId) === state.lease.native.turnId
        ? structuredClone(state.lease)
        : null,
    routes: (session) => session.serverId === attachment && session.threadId === threadId,
  });
  const gateway = new SessionCapabilityMcp(new SessionCapabilities(), key, undefined, {
    descriptorPath: join(directory, "session-capabilities.json"),
    hostEnvironment: async (session, recipient) => {
      const reply = await relay(session, recipient);
      if ("capsule" in reply) state.relayed.push(JSON.stringify(reply));
      return state.replay ?? reply;
    },
  });
  await gateway.listen();
  t.after(() => gateway.close());
  const launch = createRemoteEnvironmentLaunch({
    purpose: "dsh",
    instance: serverId,
    issuer: vault.key,
    capabilities: new RemoteSessionCapabilities(directory, serverId),
    admission: ownerAdmission(state),
  });
  t.after(() => {
    launch.close();
    vault.close();
  });
  return { directory, key, gateway, state, launch, vault };
}

function dshAgent() {
  const agent = {
    id: "native-dsh",
    status: "running",
    session: { header: { id: "native-dsh" }, events: [{ type: "turn/start", data: { turn: 7 } }] as unknown[] },
  };
  let port: any;
  const ctx = {
    agents: new Map([[agent.id, agent]]),
    provide(_name: string, value: unknown) {
      port = value;
    },
    inject() {},
  };
  return { agent, ctx, port: () => port };
}

test("DSH receives Turn ENV through an opaque capsule the Gateway relays but cannot read", async (t) => {
  const f = await fixture(t);
  const d = dshAgent();
  registerDshExecutionEnvironment(d.ctx, () => threadId, undefined, undefined, f.launch);
  const env = await d.port().prepare({ agent: d.agent, signal: new AbortController().signal });
  assert.equal(env.SERVICE_KEY, SECRET);
  assert.ok(Object.isFrozen(env));
  assert.equal(f.state.relayed.length, 1);
  assert.ok(!f.state.relayed[0]!.includes(SECRET), "the relayed reply carries only ciphertext");
  // Each launch is a fresh one-shot delivery that reads the current vault values.
  f.state.values = { SERVICE_KEY: "rotated-" + SECRET };
  assert.equal(
    (await d.port().prepare({ agent: d.agent, signal: new AbortController().signal })).SERVICE_KEY,
    "rotated-" + SECRET,
  );
  assert.equal(f.state.reads, 2);
});

test("a duplicated or replayed capsule is consumed once and never becomes a second launch", async (t) => {
  const f = await fixture(t);
  const locator = { hostId: "opencraft-server" as const, threadId, turnId };
  assert.equal((await f.launch.prepare(locator)).apply({}).SERVICE_KEY, SECRET);
  f.state.replay = JSON.parse(f.state.relayed[0]!);
  await assert.rejects(f.launch.prepare(locator), { message: "environment_launch_unavailable" });
  // A capsule without admitted context and a context for another Turn are refused.
  f.state.replay = { context: null, capsule: (f.state.replay as { capsule: string }).capsule };
  await assert.rejects(f.launch.prepare(locator));
  f.state.replay = {
    ...JSON.parse(f.state.relayed[0]!),
    context: { ...admitted(), native: { turnId: "other", incarnation: "native-original" } },
  };
  await assert.rejects(f.launch.prepare(locator));
});

test("the receiver expects its own durable admission: a disagreeing relayed context is refused", async (t) => {
  const f = await fixture(t);
  const locator = { hostId: "opencraft-server" as const, threadId, turnId };
  const original = admitted();
  // Each relay below is internally consistent: the vault owner sealed exactly the
  // context the Gateway relays. Only the owner's own admission can refuse it.
  for (const scope of [
    { inputId: "another-input" },
    { executionId: "another-execution" },
    { leaseGeneration: 2 },
    { account: "actor:human://fixture/two" },
    { actorGeneration: 2 },
    { membershipRevision: 3 },
    { projectId: "selected-by-relay" },
  ]) {
    f.state.lease = { ...original, scope: { ...original.scope, ...scope } };
    await assert.rejects(
      f.launch.prepare(locator),
      { message: "environment_launch_unavailable" },
      JSON.stringify(scope),
    );
  }
  f.state.lease = { ...original, native: { ...original.native, incarnation: "native-relayed" } };
  await assert.rejects(f.launch.prepare(locator));
  // Presence must agree as well: neither side may deny the other's admission.
  f.state.lease = null;
  await assert.rejects(f.launch.prepare(locator));
  f.state.lease = original;
  f.state.owned = null;
  await assert.rejects(f.launch.prepare(locator));
  // The owner rereads its admission around decryption; a lease that moves while
  // the capsule is in flight retires it even though the relay still agrees.
  f.state.owned = contextOf(original);
  f.state.afterSeal = () => {
    f.state.owned = { ...contextOf(original), scope: { ...original.scope, executionId: "successor-execution" } };
  };
  await assert.rejects(f.launch.prepare(locator));
  f.state.afterSeal = () => {};
  f.state.owned = contextOf(original);
  // An unreadable admission fails closed rather than trusting the relay.
  const unreadable = createRemoteEnvironmentLaunch({
    purpose: "dsh",
    instance: attachment,
    issuer: f.vault.key,
    capabilities: new RemoteSessionCapabilities(f.directory, attachment),
    admission: async () => {
      throw Error("store unavailable");
    },
  });
  t.after(() => unreadable.close());
  await assert.rejects(unreadable.prepare(locator));
  assert.equal((await f.launch.prepare(locator)).apply({}).SERVICE_KEY, SECRET);
});

test("revoked or late authority loses the capsule: lease change while sealing, Turn end, abort and restarted process", async (t) => {
  const f = await fixture(t);
  const locator = { hostId: "opencraft-server" as const, threadId, turnId };
  // The Gateway rereads the live handoff after sealing and discards a stale capsule.
  f.state.afterSeal = () => {
    f.state.lease = { ...admitted(), scope: { ...admitted().scope, leaseGeneration: 2 } };
  };
  await assert.rejects(f.launch.prepare(locator));
  f.state.afterSeal = () => {};
  f.state.lease = admitted();
  // Native incarnation is observed locally; a replacement process cannot open it.
  f.state.incarnation = "native-successor";
  await assert.rejects(f.launch.prepare(locator));
  f.state.incarnation = "native-original";
  // The DSH Turn ends between request and decryption: the overlay is never published.
  const d = dshAgent();
  registerDshExecutionEnvironment(d.ctx, () => threadId, undefined, undefined, f.launch);
  f.state.afterSeal = () => {
    d.agent.session.events.push({ type: "turn/end", data: { turn: 7 } });
  };
  await assert.rejects(d.port().prepare({ agent: d.agent, signal: new AbortController().signal }));
  d.agent.session.events.pop();
  const aborted = new AbortController();
  f.state.afterSeal = () => aborted.abort();
  await assert.rejects(d.port().prepare({ agent: d.agent, signal: aborted.signal }));
  f.state.afterSeal = () => {};
  // Closing the receiver retires its key; later deliveries fail closed.
  f.launch.close();
  await assert.rejects(f.launch.prepare(locator));
});

test("unowned Turns receive an empty launch while a capsule for another attachment or issuer is refused", async (t) => {
  const f = await fixture(t);
  const locator = { hostId: "opencraft-server" as const, threadId, turnId };
  f.state.lease = null;
  f.state.owned = null;
  const empty = await f.launch.prepare(locator);
  assert.deepEqual(empty.overlay(), {});
  assert.equal(f.state.reads, 0, "no vault read without an admitted Human lease");
  f.state.lease = admitted();
  f.state.owned = contextOf(admitted());
  // Same token key, different attachment: the Gateway refuses to route it.
  const other = createRemoteEnvironmentLaunch({
    purpose: "dsh",
    instance: "server:fixture:pi",
    issuer: f.vault.key,
    capabilities: new RemoteSessionCapabilities(f.directory, "server:fixture:pi"),
    admission: ownerAdmission(f.state),
  });
  t.after(() => other.close());
  await assert.rejects(other.prepare(locator));
  // A receiver pinned to another issuer cannot open the genuine vault's capsule.
  const pinnedElsewhere = createRemoteEnvironmentLaunch({
    purpose: "dsh",
    instance: attachment,
    issuer: new EnvironmentLaunchIssuer().key,
    capabilities: new RemoteSessionCapabilities(f.directory, attachment),
    admission: ownerAdmission(f.state),
  });
  t.after(() => pinnedElsewhere.close());
  await assert.rejects(pinnedElsewhere.prepare(locator));
  await assert.rejects(f.launch.prepare({ hostId: "local-codex", threadId, inputId: "original-input" }));
});

test("the ENV route has its own audience and accepts only a receiver key", async (t) => {
  const f = await fixture(t);
  const url = new URL("/host-environment", f.gateway.cliEndpoint);
  const source = { serverId: attachment, threadId, source: { turnId } };
  const recipient = randomBytes(8).toString("base64url");
  const post = (token: string, body: unknown, path = url) =>
    fetch(path, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post(hostGitToken(f.key, source), { recipient })).status, 401);
  assert.equal(
    (await post(hostEnvironmentToken(f.key, source), {}, new URL("/host-git", f.gateway.cliEndpoint))).status,
    401,
  );
  for (const body of [{}, { recipient, account: "actor:human://forged/one" }, { recipient: "bad key" }, [recipient]])
    assert.equal((await post(hostEnvironmentToken(f.key, source), body)).status, 400);
  assert.equal(f.state.reads, 0);
});

test("compatibility: without a vault-owner port DSH and the synchronous runtime behave as before", async () => {
  const d = dshAgent();
  registerDshExecutionEnvironment(d.ctx, () => threadId);
  assert.deepEqual(await d.port().prepare({ agent: d.agent, signal: new AbortController().signal }), {});
  assert.deepEqual(d.port().environment("native-dsh"), {});
  const legacy = dshAgent();
  const runtime = {
    execution: (hostId: string, id: string) => ({ account: "provider:one", hostId, threadId: id, projectId: null }),
    snapshot: () => ({ apply: (base: object) => base, overlay: () => ({ SERVICE_KEY: "legacy" }) }),
  };
  registerDshExecutionEnvironment(legacy.ctx, () => threadId, runtime);
  assert.deepEqual(legacy.port().environment("native-dsh"), { SERVICE_KEY: "legacy" });
  assert.throws(() => registerDshExecutionEnvironment(dshAgent().ctx, () => threadId, runtime, undefined, {}), {
    message: "Execution ENV cannot have two owners",
  });
  const base = { providers: [], close() {} };
  validateHeadlessIdentity(base);
  validateHeadlessIdentity({ ...base, environmentLaunch: { issuer: "a".repeat(44), seal: async () => "" } });
  assert.throws(() =>
    validateHeadlessIdentity({
      ...base,
      executionEnvironment: {},
      environmentLaunch: { issuer: "a".repeat(44), seal: async () => "" },
    }),
  );
});
