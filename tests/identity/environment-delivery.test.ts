import test from "node:test";
import assert from "node:assert/strict";
import {
  EnvironmentLaunchIssuer,
  EnvironmentLaunchReceiver,
  type EnvironmentLaunchContext,
} from "@opencraft/execution-environment/environment-delivery";

const original = (): EnvironmentLaunchContext => ({
  scope: {
    account: "actor:human://fixture/one",
    hostId: "local-codex",
    threadId: "thread",
    inputId: "input",
    executionId: "execution",
    leaseGeneration: 1,
    actorGeneration: 1,
    membershipRevision: 0,
    projectId: "project",
  },
  native: { turnId: "turn", incarnation: "native-original" },
});
function fixture() {
  let now = Date.now();
  const issuer = new EnvironmentLaunchIssuer(() => now);
  const receiver = new EnvironmentLaunchReceiver({
    purpose: "codex",
    instance: "authenticated-process",
    issuer: issuer.key,
    authorize: async () => {},
    now: () => now,
  });
  const seal = (scope = original(), values: unknown = { SERVICE_KEY: "synthetic-worker-only-value" }) =>
    issuer.seal(
      receiver.target,
      scope,
      () => values,
      () => {},
    );
  return {
    issuer,
    receiver,
    seal,
    advance: () => {
      now += 60001;
    },
  };
}

test("authenticated ENV delivery is opaque, exact-recipient/Native-bound and consumed only once", async () => {
  const f = fixture(),
    envelope = f.seal();
  assert.ok(!envelope.includes("synthetic-worker-only-value"));
  const snapshot = await f.receiver.open(envelope, original());
  assert.equal(snapshot.apply({}).SERVICE_KEY, "synthetic-worker-only-value");
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-worker-only-value"));
  assert.equal(snapshot.redact("prefix synthetic-worker-only-value suffix"), "prefix [REDACTED] suffix");
  await assert.rejects(f.receiver.open(envelope, original()), { message: "environment_launch_unavailable" });
  const peer = new EnvironmentLaunchReceiver({
    purpose: "codex",
    instance: "authenticated-process",
    issuer: f.issuer.key,
    authorize: async () => {},
  });
  await assert.rejects(peer.open(f.seal(), original()));
  f.receiver.close();
  peer.close();
  f.issuer.close();
});

test("neither changed scope nor a fabricated sender/ciphertext can supply execution ENV", async () => {
  const f = fixture(),
    envelope = f.seal();
  for (const [field, value] of Object.entries({
    account: "actor:human://fixture/two",
    threadId: "other",
    inputId: "other",
    executionId: "other",
    leaseGeneration: 2,
    actorGeneration: 2,
    membershipRevision: 2,
    projectId: null,
  })) {
    await assert.rejects(f.receiver.open(envelope, { ...original(), scope: { ...original().scope, [field]: value } }));
  }
  for (const field of ["turnId", "incarnation"])
    await assert.rejects(
      f.receiver.open(envelope, {
        ...original(),
        native: { ...original().native, [field]: "other" },
      }),
    );
  const attacker = new EnvironmentLaunchIssuer();
  const forged = JSON.parse(
    Buffer.from(
      attacker
        .seal(
          f.receiver.target,
          original(),
          () => ({ SERVICE_KEY: "forged" }),
          () => {},
        )
        .slice(5),
      "base64url",
    ).toString(),
  );
  forged.issuer = f.issuer.key;
  await assert.rejects(
    f.receiver.open("env1." + Buffer.from(JSON.stringify(forged)).toString("base64url"), original()),
  );
  const edited = JSON.parse(Buffer.from(envelope.slice(5), "base64url").toString());
  edited.context.scope.projectId = "other";
  await assert.rejects(
    f.receiver.open("env1." + Buffer.from(JSON.stringify(edited)).toString("base64url"), {
      ...original(),
      scope: { ...original().scope, projectId: "other" },
    }),
  );
  assert.equal((await f.receiver.open(envelope, original())).apply({}).SERVICE_KEY, "synthetic-worker-only-value");
  f.receiver.close();
  f.issuer.close();
  attacker.close();
});

test("expired capsules, wrong purposes and platform/invalid ENV cannot become a silent empty launch", async () => {
  const f = fixture();
  for (const values of [{ NODE_OPTIONS: "synthetic" }, { SERVICE_KEY: null }, { SERVICE_KEY: "x\0y" }])
    assert.throws(() => f.seal(original(), values), { message: "environment_launch_unavailable" });
  assert.throws(() => f.seal({ ...original(), scope: { ...original().scope, account: "platform:environment" } }));
  const wrong = new EnvironmentLaunchReceiver({
    purpose: "pi",
    instance: "other",
    issuer: f.issuer.key,
    authorize: async () => {},
  });
  let reads = 0;
  assert.throws(() =>
    f.issuer.seal(
      wrong.target,
      original(),
      () => {
        reads++;
        return {};
      },
      () => {},
    ),
  );
  assert.equal(reads, 0);
  const envelope = f.seal();
  f.advance();
  await assert.rejects(f.receiver.open(envelope, original()));
  f.receiver.close();
  wrong.close();
  f.issuer.close();
});

test("concurrent delivery cannot consume a capsule twice and late original-authority loss prevents publication", async () => {
  const issuer = new EnvironmentLaunchIssuer();
  let checks = 0,
    active = true;
  const receiver = new EnvironmentLaunchReceiver({
    purpose: "codex",
    instance: "process",
    issuer: issuer.key,
    authorize: async () => {
      checks++;
      await Promise.resolve();
      if (!active) throw Error("retired");
    },
  });
  const seal = () =>
    issuer.seal(
      receiver.target,
      original(),
      () => ({ SERVICE_KEY: "secret" }),
      () => {},
    );
  const envelope = seal(),
    results = await Promise.allSettled([receiver.open(envelope, original()), receiver.open(envelope, original())]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(checks >= 3);
  const pending = receiver.open(seal(), original());
  active = false;
  await assert.rejects(pending);
  receiver.close();
  issuer.close();
});

test("global+project size limits survive opaque transport and still reject platform environment collisions", async () => {
  const f = fixture();
  const values = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["SERVICE_" + i, "\x01".repeat(16384)]));
  const capsule = f.seal(original(), values);
  assert.ok(capsule.length < 2 * 1024 ** 2);
  const snapshot = await f.receiver.open(capsule, original());
  assert.equal(snapshot.apply({}).SERVICE_0!.length, 16384);
  assert.throws(() => snapshot.apply({ SERVICE_0: "platform" }), { message: "reserved" });
  assert.throws(() => f.seal(original(), { ...values, SERVICE_EXTRA: "x" }));
  f.receiver.close();
  f.issuer.close();
});

test("receiver pins the original issuer options and bounds pending authorization without leaking plaintext", async () => {
  const issuer = new EnvironmentLaunchIssuer();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const options = { purpose: "codex" as const, instance: "process", issuer: issuer.key, authorize: async () => gate };
  const receiver = new EnvironmentLaunchReceiver(options);
  options.issuer = "mutated-by-caller";
  const seal = () =>
    issuer.seal(
      receiver.target,
      original(),
      () => ({ SERVICE_KEY: "secret" }),
      () => {},
    );
  const pending = Array.from({ length: 16 }, () => receiver.open(seal(), original()));
  await assert.rejects(receiver.open(seal(), original()));
  receiver.close();
  resume();
  const results = await Promise.allSettled(pending);
  assert.ok(results.every((r) => r.status === "rejected"));
  issuer.close();
});

test("a delayed authorization reply cannot extend the original request's shorter expiry", async () => {
  let now = Date.now(),
    resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const issuer = new EnvironmentLaunchIssuer(() => now);
  const receiver = new EnvironmentLaunchReceiver({
    purpose: "codex",
    instance: "process",
    issuer: issuer.key,
    authorize: async () => gate,
    now: () => now,
  });
  const capsule = issuer.seal(
    receiver.target,
    original(),
    () => ({ SERVICE_KEY: "secret" }),
    () => {},
    now + 10,
  );
  const pending = receiver.open(capsule, original());
  now += 11;
  resume();
  await assert.rejects(pending);
  issuer.close();
  receiver.close();
});

test("legitimate long Native IDs bind in full without exceeding the HKDF info limit", async () => {
  const f = fixture();
  const scope = original();
  const expected = {
    scope: { ...scope.scope, threadId: "t".repeat(512), inputId: "i".repeat(512), executionId: "e".repeat(512) },
    native: { turnId: "n".repeat(1024), incarnation: "p".repeat(1024) },
  };
  const capsule = f.seal(expected);
  assert.equal((await f.receiver.open(capsule, expected)).apply({}).SERVICE_KEY, "synthetic-worker-only-value");
  await assert.rejects(
    f.receiver.open(f.seal(expected), {
      ...expected,
      native: { ...expected.native, incarnation: "p".repeat(1023) + "q" },
    }),
  );
  f.receiver.close();
  f.issuer.close();
});
