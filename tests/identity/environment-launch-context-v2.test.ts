import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvironmentLaunchIssuer,
  EnvironmentLaunchReceiver,
  type AnyEnvironmentLaunchContext,
  type EnvironmentCreationAdmission,
  type EnvironmentLaunchAdmission,
  type EnvironmentLaunchContext,
  type EnvironmentLaunchPurpose,
  type EnvironmentTerminalAdmission,
  type EnvironmentTurnAdmission,
} from "@opencraft/execution-environment/environment-delivery";
import {
  EnvironmentLaunchOwner,
  type EnvironmentLaunchRecordReaders,
} from "@opencraft/execution-environment/environment-launch-owner";
import {
  createEnvironmentLaunchAdmissionReceiver,
  type EnvironmentLaunchAdmissionReaders,
  type EnvironmentLaunchLocator,
} from "@opencraft/execution-environment/environment-launch-receiver";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { AccountEnvironment } from "@opencraft/execution-environment/account-environment";
import { ExecutionEnvironmentRuntime, environmentProjectId } from "@opencraft/execution-environment";

const ACCOUNT = "actor:human://fixture/one";
const SECRET = "synthetic-v2-only-value";
const actor = { account: ACCOUNT, actorGeneration: 1, membershipRevision: 0 };
const turn = (hostId: "local-codex" | "opencraft-server" = "opencraft-server"): EnvironmentTurnAdmission => ({
  kind: "turn",
  ...actor,
  hostId,
  threadId: "thread",
  inputId: "input",
  executionId: "execution",
  leaseGeneration: 1,
  turnId: "turn",
  incarnation: "native",
});
const creation = (hostId: "local-codex" | "opencraft-server" = "opencraft-server"): EnvironmentCreationAdmission => ({
  kind: "creation",
  ...actor,
  hostId,
  operationId: "operation",
  source: null,
  incarnation: "owner",
});
const terminal = (): EnvironmentTerminalAdmission => ({
  kind: "terminal",
  ...actor,
  hostId: "opencraft-server",
  threadId: "thread",
  resource: "resource",
  operation: "operation",
  incarnation: "owner",
});
const v2 = (admission: EnvironmentLaunchAdmission) => ({ version: 2 as const, admission });
/** The v1 Turn context carrying the same facts as `turn()`. */
const v1 = (hostId: "local-codex" | "opencraft-server" = "opencraft-server"): EnvironmentLaunchContext => ({
  scope: {
    account: ACCOUNT,
    hostId,
    threadId: "thread",
    inputId: "input",
    executionId: "execution",
    leaseGeneration: 1,
    actorGeneration: 1,
    membershipRevision: 0,
    projectId: null,
  },
  native: { turnId: "turn", incarnation: "native" },
});
function pair(purpose: EnvironmentLaunchPurpose, issuer = new EnvironmentLaunchIssuer()) {
  const receiver = new EnvironmentLaunchReceiver({
    purpose,
    instance: "authenticated-process",
    issuer: issuer.key,
    authorize: async () => {},
  });
  const seal = (context: AnyEnvironmentLaunchContext) =>
    issuer.seal(
      receiver.target,
      context,
      () => ({ SERVICE_KEY: SECRET }),
      () => {},
    );
  return {
    issuer,
    receiver,
    seal,
    close() {
      receiver.close();
      issuer.close();
    },
  };
}
const refused = { message: "environment_launch_unavailable" };

test("v1 and v2 are domain separated: a capsule of one version never opens as the other", async () => {
  const p = pair("dsh");
  const one = p.seal(v1()),
    two = p.seal(v2(turn()));
  assert.match(one, /^env1\./u);
  assert.match(two, /^env2\./u);
  // The owner's expected context, not the capsule, selects the version.
  await assert.rejects(p.receiver.open(one, v2(turn())), refused);
  await assert.rejects(p.receiver.open(two, v1()), refused);
  // Relabelling the prefix cannot move a capsule into the other domain.
  await assert.rejects(p.receiver.open("env2." + one.slice(5), v2(turn())), refused);
  await assert.rejects(p.receiver.open("env1." + two.slice(5), v1()), refused);
  // A v2 body carrying a v1-shaped context, or the reverse, is malformed.
  const body = (capsule: string) => JSON.parse(Buffer.from(capsule.slice(5), "base64url").toString());
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  await assert.rejects(p.receiver.open("env2." + encode({ ...body(two), context: v1() }), v2(turn())), refused);
  // The same Turn facts re-labelled as v2 fail authentication: the associated
  // data of each version has its own domain label.
  await assert.rejects(p.receiver.open("env2." + encode({ ...body(one), context: v2(turn()) }), v2(turn())), refused);
  await assert.rejects(p.receiver.open("env1." + encode({ ...body(two), context: v1() }), v1()), refused);
  // Both still open in their own domain, once each.
  assert.equal((await p.receiver.open(one, v1())).apply({}).SERVICE_KEY, SECRET);
  assert.equal((await p.receiver.open(two, v2(turn()))).apply({}).SERVICE_KEY, SECRET);
  p.close();
});

test("v1 compatibility: v1 capsules keep opening and v1 cannot express the new purposes", async () => {
  const p = pair("codex");
  const snapshot = await p.receiver.open(p.seal(v1("local-codex")), v1("local-codex"));
  assert.equal(snapshot.apply({}).SERVICE_KEY, SECRET);
  for (const purpose of ["acp", "terminal"] as const) {
    const q = pair(purpose);
    let reads = 0;
    assert.throws(
      () =>
        q.issuer.seal(
          q.receiver.target,
          v1(),
          () => {
            reads++;
            return {};
          },
          () => {},
        ),
      refused,
    );
    assert.equal(reads, 0, "no value is read for a context the purpose cannot carry");
    q.close();
  }
  p.close();
});

test("no cross-kind confusion: creation, terminal and turn never open as each other", async () => {
  const kinds = { turn: turn(), creation: creation(), terminal: terminal() };
  // Same Actor, Host and overlapping identifiers: only the kind differs.
  for (const purpose of ["acp", "terminal"] as const) {
    const p = pair(purpose);
    for (const [kind, admission] of Object.entries(kinds)) {
      let capsule: string;
      try {
        capsule = p.seal(v2(admission));
      } catch {
        continue; // not a kind this purpose carries
      }
      for (const [other, expected] of Object.entries(kinds))
        if (other !== kind) await assert.rejects(p.receiver.open(capsule, v2(expected)), refused, `${kind}→${other}`);
    }
    p.close();
  }
  // A field belonging to another kind cannot ride along.
  const p = pair("acp");
  for (const forged of [
    { ...creation(), threadId: "thread" },
    { ...turn(), operationId: "operation" },
    { ...creation(), kind: "terminal" },
    { ...creation(), projectId: "project" },
    { ...creation(), account: "platform:environment" },
    { ...creation(), actorGeneration: 0 },
  ])
    assert.throws(() => p.seal(v2(forged as EnvironmentLaunchAdmission)), refused, JSON.stringify(forged));
  assert.throws(() => p.seal({ ...v2(creation()), projectId: "project" } as never), refused);
  p.close();
});

test("wrong purpose, Host or audience refuses each kind", async () => {
  const matrix: [EnvironmentLaunchPurpose, EnvironmentLaunchAdmission, boolean][] = [
    ["dsh", turn(), true],
    ["pi", turn(), true],
    ["acp", turn(), true],
    ["codex", turn("local-codex"), true],
    ["acp", creation(), true],
    ["codex", creation("local-codex"), true],
    ["terminal", terminal(), true],
    ["terminal", { ...terminal(), hostId: "local-codex" }, true],
    ["dsh", creation(), false],
    ["pi", creation(), false],
    ["dsh", terminal(), false],
    ["acp", terminal(), false],
    ["codex", terminal(), false],
    ["terminal", turn(), false],
    ["terminal", creation(), false],
    ["codex", creation("opencraft-server"), false],
    ["acp", creation("local-codex"), false],
    ["codex", turn("opencraft-server"), false],
  ];
  for (const [purpose, admission, allowed] of matrix) {
    const p = pair(purpose);
    if (allowed) {
      const capsule = p.seal(v2(admission));
      // Another purpose, attachment or receiver key cannot open it.
      const other = new EnvironmentLaunchReceiver({
        purpose: purpose === "terminal" ? "acp" : "terminal",
        instance: "authenticated-process",
        issuer: p.issuer.key,
        authorize: async () => {},
      });
      const peer = new EnvironmentLaunchReceiver({
        purpose,
        instance: "another-process",
        issuer: p.issuer.key,
        authorize: async () => {},
      });
      await assert.rejects(other.open(capsule, v2(admission)), refused);
      await assert.rejects(peer.open(capsule, v2(admission)), refused);
      assert.equal((await p.receiver.open(capsule, v2(admission))).apply({}).SERVICE_KEY, SECRET);
      other.close();
      peer.close();
    } else {
      assert.throws(() => p.seal(v2(admission)), refused, `${purpose}/${admission.kind}/${admission.hostId}`);
      // Nor does the receiver accept such an expectation.
      await assert.rejects(p.receiver.open("env2.e30", v2(admission)), refused);
    }
    p.close();
  }
});

test("replay and one-shot per kind: a Turn launches once per capsule, creation and terminal once per admission", async () => {
  const acp = pair("acp");
  const t1 = acp.seal(v2(turn())),
    t2 = acp.seal(v2(turn()));
  assert.ok(await acp.receiver.open(t1, v2(turn())));
  await assert.rejects(acp.receiver.open(t1, v2(turn())), refused, "replayed Turn capsule");
  assert.ok(await acp.receiver.open(t2, v2(turn())), "a fresh capsule launches the next command of the Turn");

  const c1 = acp.seal(v2(creation())),
    c2 = acp.seal(v2(creation()));
  const concurrent = await Promise.allSettled([
    acp.receiver.open(c1, v2(creation())),
    acp.receiver.open(c2, v2(creation())),
  ]);
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1, "one creation launch");
  await assert.rejects(acp.receiver.open(acp.seal(v2(creation())), v2(creation())), refused);
  // Another creation operation is its own admission.
  const next = { ...creation(), operationId: "operation-2" };
  assert.ok(await acp.receiver.open(acp.seal(v2(next)), v2(next)));
  acp.close();

  const term = pair("terminal");
  assert.ok(await term.receiver.open(term.seal(v2(terminal())), v2(terminal())));
  await assert.rejects(term.receiver.open(term.seal(v2(terminal())), v2(terminal())), refused);
  const again = { ...terminal(), operation: "operation-2" };
  assert.ok(await term.receiver.open(term.seal(v2(again)), v2(again)));
  term.close();
});

test("snapshots report the admitted scope and never a Project", async () => {
  const p = pair("acp");
  const snapshot = await p.receiver.open(p.seal(v2(creation())), v2(creation()));
  assert.equal(snapshot.account, ACCOUNT);
  const peer = pair("acp");
  const unbound = await peer.receiver.open(peer.seal(v2(turn())), v2(turn()));
  assert.equal(snapshot.owner, unbound.owner, "same account and Host, no Project in either");
  p.close();
  peer.close();
});

/** Owner-side receiver over a stub relay; only the durable readers can refuse. */
function owned(
  purpose: EnvironmentLaunchPurpose,
  readers: EnvironmentLaunchAdmissionReaders,
  issuer = new EnvironmentLaunchIssuer(),
) {
  const launch = createEnvironmentLaunchAdmissionReceiver({
    purpose,
    instance: "authenticated-process",
    issuer: issuer.key,
    admission: readers,
  });
  // The issuer refuses kinds this purpose cannot carry; the relay then has only
  // a placeholder, so the receiver's own refusal is what these cases exercise.
  const capsule = (admission: EnvironmentLaunchAdmission) => {
    try {
      return issuer.seal(
        launch.target,
        v2(admission),
        () => ({ SERVICE_KEY: SECRET }),
        () => {},
      );
    } catch {
      return "env2.e30";
    }
  };
  const reply = (admission: EnvironmentLaunchAdmission | null) =>
    admission === null ? { context: null } : { context: v2(admission), capsule: capsule(admission) };
  return { launch, reply, issuer };
}
const at = {
  turn: { kind: "turn", hostId: "opencraft-server", threadId: "thread", inputId: "input" },
  creation: { kind: "creation", hostId: "opencraft-server", operationId: "operation" },
  terminal: { kind: "terminal", hostId: "opencraft-server", resource: "resource", operation: "operation" },
} satisfies Record<string, EnvironmentLaunchLocator>;

test("the receiver admits each kind only from its own durable record", async () => {
  let record: EnvironmentCreationAdmission | null = creation();
  const f = owned("acp", { creation: async () => record });
  assert.deepEqual(f.launch.kinds, ["creation"], "a kind without a reader is not admitted");
  // Turn is allowed for ACP but no Turn reader is composed: refused before any request.
  await assert.rejects(f.launch.open(at.turn, f.reply(turn())), refused);
  await assert.rejects(f.launch.open(at.terminal, f.reply(terminal())), refused);
  // A relayed context that disagrees with the record is refused.
  const relayedOther = f.reply({ ...creation(), account: "actor:human://fixture/two" });
  await assert.rejects(f.launch.open(at.creation, relayedOther), refused);
  await assert.rejects(f.launch.open(at.creation, f.reply({ ...creation(), source: "thread" })), refused);
  // A locator for another record cannot borrow this one.
  await assert.rejects(f.launch.open({ ...at.creation, operationId: "operation-2" }, f.reply(creation())), refused);
  // A record that changed since the relay sealed refuses.
  const pending = f.reply(creation());
  record = { ...creation(), actorGeneration: 2 };
  await assert.rejects(f.launch.open(at.creation, pending), refused);
  record = creation();
  // A record leaving its admissible state during decryption retires the capsule.
  let reads = 0;
  const late = owned("acp", { creation: async () => (++reads > 2 ? null : creation()) });
  await assert.rejects(late.launch.open(at.creation, late.reply(creation())), refused);
  assert.ok(reads >= 3, "reread before and after decryption");
  late.launch.close();
  late.issuer.close();
  assert.equal((await f.launch.open(at.creation, f.reply(creation()))).apply({}).SERVICE_KEY, SECRET);
  // The same admission never launches twice.
  await assert.rejects(f.launch.open(at.creation, f.reply(creation())), refused);
  f.launch.close();
  f.issuer.close();
});

test("the receiver refuses kinds outside its purpose even with a reader, and handles no Human admission", async () => {
  const term = owned("terminal", {
    terminal: async () => null,
    turn: async () => turn(),
    creation: async () => creation(),
  });
  assert.deepEqual(term.launch.kinds, ["terminal"]);
  await assert.rejects(term.launch.open(at.turn, term.reply(turn())), refused);
  await assert.rejects(term.launch.open(at.creation, term.reply(creation())), refused);
  // No Human admission on either side: an empty launch.
  assert.deepEqual((await term.launch.open(at.terminal, { context: null })).apply({}), {});
  // A relay claiming an admission the owner does not hold is refused.
  await assert.rejects(term.launch.open(at.terminal, term.reply(terminal())), refused);
  term.launch.close();
  term.issuer.close();

  const held = owned("terminal", { terminal: async () => terminal() });
  // A relay denying an admission the owner holds is refused, as is a capsule without context.
  await assert.rejects(held.launch.open(at.terminal, { context: null }), refused);
  await assert.rejects(held.launch.open(at.terminal, { context: null, capsule: "env2.e30" }), refused);
  // A record that names another locator is refused.
  const mismatched = owned("terminal", { terminal: async () => ({ ...terminal(), resource: "elsewhere" }) });
  await assert.rejects(mismatched.launch.open(at.terminal, mismatched.reply(terminal())), refused);
  assert.ok(await held.launch.open(at.terminal, held.reply(terminal())));
  for (const f of [held, mismatched]) {
    f.launch.close();
    f.issuer.close();
  }
});

/** Vault with personal and Project values, and a Thread bound to `alpha`. */
async function vault(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "env-v2-"));
  const store = await EmployeeGitVaultStore.open(directory);
  const environment = new AccountEnvironment(store);
  environment.replace(ACCOUNT, { projectId: null }, 0, [
    { name: "SERVICE_KEY", value: SECRET, secret: true },
    { name: "SHARED", value: "global", secret: false },
  ]);
  for (const project of ["alpha", "beta"])
    environment.replace(ACCOUNT, { projectId: environmentProjectId("opencraft-server", project) }, 0, [
      { name: "SHARED", value: project, secret: true },
    ]);
  new ExecutionEnvironmentRuntime(directory, store, false, "disabled").bind("opencraft-server", "thread", "alpha");
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}
const handoff = (a = turn()) => ({
  scope: {
    account: a.account,
    hostId: a.hostId,
    threadId: a.threadId,
    inputId: a.inputId,
    executionId: a.executionId,
    leaseGeneration: a.leaseGeneration,
    actorGeneration: a.actorGeneration,
    membershipRevision: a.membershipRevision,
    projectId: null,
  },
  native: { turnId: a.turnId, incarnation: a.incarnation },
});

test("the issuer refuses kinds it cannot admit and checks each kind against its own durable record", async (t) => {
  const store = await vault(t);
  let creationRecord: EnvironmentCreationAdmission | null = creation();
  let creationProject: string | null = "beta";
  let reads = 0;
  const records: EnvironmentLaunchRecordReaders = {
    creation: (locator) => {
      reads++;
      return creationRecord && creationRecord.operationId === locator.operationId
        ? { admission: creationRecord, project: creationProject }
        : null;
    },
  };
  const owner = new EnvironmentLaunchOwner(store, () => handoff(), records);
  const bare = new EnvironmentLaunchOwner(store, () => handoff());
  const issuers = [owner, bare];
  const receiver = (purpose: EnvironmentLaunchPurpose, issuer: string) =>
    new EnvironmentLaunchReceiver({ purpose, instance: "process", issuer, authorize: async () => {} });
  try {
    // Without a record reader the kind is refused, never sealed from the claim.
    const term = receiver("terminal", owner.issuer);
    assert.throws(() => owner.seal(term.target, v2(terminal())), refused);
    const acp = receiver("acp", bare.issuer);
    assert.throws(() => bare.seal(acp.target, v2(creation())), refused);
    term.close();
    acp.close();

    // Creation: the Project comes from the durable record, not the context.
    const r = receiver("acp", owner.issuer);
    const opened = await r.open(owner.seal(r.target, v2(creation())), v2(creation()));
    assert.equal(opened.apply({}).SHARED, "beta");
    assert.equal(opened.apply({}).SERVICE_KEY, SECRET);
    // A claim that is not the record is refused.
    for (const claim of [
      { ...creation(), operationId: "operation-2" },
      { ...creation(), account: "actor:human://fixture/two" },
      { ...creation(), actorGeneration: 2 },
      { ...creation(), source: "thread" },
      { ...creation(), incarnation: "owner-restarted" },
    ])
      assert.throws(() => owner.seal(r.target, v2(claim)), refused, JSON.stringify(claim));
    // A record leaving its admissible state, or a Project change, while sealing refuses.
    const flip = new EnvironmentLaunchOwner(store, () => null, {
      creation: () => {
        const value = { admission: creation(), project: reads % 2 ? "alpha" : "beta" };
        reads++;
        return value;
      },
    });
    issuers.push(flip);
    const rf = receiver("acp", flip.issuer);
    assert.throws(() => flip.seal(rf.target, v2(creation())), refused);
    creationRecord = null;
    assert.throws(() => owner.seal(r.target, v2(creation())), refused);
    creationRecord = creation();
    creationProject = null;
    // The receiver already launched this creation once.
    await assert.rejects(r.open(owner.seal(r.target, v2(creation())), v2(creation())), refused);
    const fresh = receiver("acp", owner.issuer);
    assert.equal(
      (await fresh.open(owner.seal(fresh.target, v2(creation())), v2(creation()))).apply({}).SHARED,
      "global",
      "a record without a Project yields personal values only",
    );
    fresh.close();
    rf.close();
    r.close();

    // Turn (v2): the lease admission and the Thread binding, as for v1.
    const dsh = receiver("dsh", owner.issuer);
    const t2 = await dsh.open(owner.seal(dsh.target, v2(turn())), v2(turn()));
    assert.equal(t2.apply({}).SHARED, "alpha", "Project from the Thread binding");
    assert.throws(() => owner.seal(dsh.target, v2({ ...turn(), executionId: "forged" })), refused);
    // v1 keeps working through the same owner.
    assert.equal((await dsh.open(owner.seal(dsh.target, v1()), v1())).apply({}).SHARED, "alpha");
    dsh.close();
  } finally {
    for (const issuer of issuers) issuer.close();
  }
});
