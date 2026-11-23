import assert from "node:assert/strict";
import test from "node:test";
import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { openActorAdmission } from "@opencraft/headless-server/workspaces/actor-admission";

const actorId = "human://fixture/actor-admission";

function fixture(options: { lazy?: boolean } = {}) {
  const state = { generation: 1, revision: 0, enabled: true, admitted: true, accessReady: !options.lazy };
  const actorListeners = new Set<() => void>(),
    memberListeners = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const notify = () => {
    for (const listener of [...actorListeners, ...memberListeners]) listener();
  };
  const access = { admitsActor: () => state.admitted };
  const admission = openActorAdmission({
    actors: {
      get: (id) =>
        id === actorId
          ? {
              id,
              kind: "human",
              enabled: state.enabled,
              generation: state.generation,
              displayName: "Fixture",
              createdAt: 0,
              createdBy: null,
            }
          : null,
      findHuman: (principal) =>
        principal.provider === "local" && principal.subject === "fixture"
          ? {
              id: actorId,
              kind: "human",
              enabled: state.enabled,
              generation: state.generation,
              displayName: "Fixture",
              createdAt: 0,
              createdBy: null,
            }
          : null,
      isCurrent: (context) =>
        state.enabled && context.generation === state.generation && context.expiresAt > Date.now(),
      bindings: () => [{ provider: "local", subject: "fixture" }],
      onAuthorityChanged: subscribe(actorListeners),
    },
    membership: { revocationRevision: () => state.revision, onAuthorityChanged: subscribe(memberListeners) },
    access: options.lazy ? () => (state.accessReady ? access : undefined) : access,
  });
  return { admission, state, notify, listeners: () => actorListeners.size + memberListeners.size };
}
const principal = (overrides: Partial<{ provider: string; subject: string; expiresAt: number }> = {}) => ({
  provider: "local",
  subject: "fixture",
  expiresAt: Date.now() + 600_000,
  ...overrides,
});

test("login principal path is bounded and refuses expired, foreign-provider and unknown humans", (t) => {
  const f = fixture();
  t.after(f.admission.close);
  const before = Date.now();
  const proof = f.admission.admitPrincipal(principal());
  assert.equal(proof.actorId, actorId);
  assert.equal(proof.generation, 1);
  assert.ok(proof.expiresAt <= Date.now() + 120_000 && proof.expiresAt >= before + 120_000);
  const shortLogin = Date.now() + 5_000;
  assert.equal(f.admission.admitPrincipal(principal({ expiresAt: shortLogin })).expiresAt, shortLogin);
  assert.equal(f.admission.admitPrincipal(principal(), { provider: "local" }).actorId, actorId);
  assert.throws(() => f.admission.admitPrincipal(principal({ expiresAt: Date.now() - 1 })));
  assert.throws(() => f.admission.admitPrincipal(principal(), { provider: "oidc" }));
  assert.throws(() => f.admission.admitPrincipal(principal({ subject: "someone-else" })));
  assert.throws(() => f.admission.admitPrincipal(null));
  f.state.enabled = false;
  assert.throws(() => f.admission.admitPrincipal(principal()));
});

test("resource path pins an optional generation and shares one resource permit per Actor epoch", (t) => {
  const f = fixture();
  t.after(f.admission.close);
  const context: TransportSubmissionContext = {
    sender: null,
    actorContext: { actorId, generation: 1, credentialId: null, expiresAt: Date.now() + 60_000 },
  };
  const pinned = f.admission.admitResource(actorId, 1),
    floating = f.admission.admitResource(actorId),
    login = f.admission.admitPrincipal(principal()),
    request = f.admission.admit(context);
  assert.ok(pinned.expiresAt <= Date.now() + 30_000);
  for (const other of [floating, login, request]) {
    assert.equal(other.resourcePermit, pinned.resourcePermit);
    assert.notEqual(other.requestPermit, pinned.requestPermit);
  }
  assert.throws(() => f.admission.admitResource(actorId, 2));
  f.state.generation = 2;
  f.notify();
  assert.equal(Atomics.load(pinned.resourcePermit, 0), 0);
  assert.throws(() => f.admission.admitResource(actorId, 1), "A recorded epoch does not follow a new generation");
  const current = f.admission.admitResource(actorId);
  assert.equal(current.generation, 2);
  assert.equal(Atomics.load(current.resourcePermit, 0), 1);
  assert.throws(() => f.admission.admitResource("human://fixture/unknown"));
});

test("Actor disable, membership revocation and close retire issued resource permits", () => {
  const f = fixture();
  const first = f.admission.admitPrincipal(principal());
  f.state.enabled = false;
  f.notify();
  assert.equal(Atomics.load(first.resourcePermit, 0), 0);
  f.state.enabled = true;
  const second = f.admission.admitResource(actorId);
  assert.notEqual(second.resourcePermit, first.resourcePermit);
  f.state.revision++;
  f.notify();
  assert.equal(Atomics.load(second.resourcePermit, 0), 0);
  const third = f.admission.admitResource(actorId);
  f.state.admitted = false;
  f.notify();
  assert.equal(Atomics.load(third.resourcePermit, 0), 0);
  f.state.admitted = true;
  const last = f.admission.admitResource(actorId);
  f.admission.close();
  assert.equal(Atomics.load(last.resourcePermit, 0), 0);
  assert.equal(f.listeners(), 0);
  assert.throws(() => f.admission.admitResource(actorId));
  assert.throws(() => f.admission.admitPrincipal(principal()));
});

test("lazy instance access issues nothing until it exists and retires permits when it goes away", (t) => {
  const f = fixture({ lazy: true });
  t.after(f.admission.close);
  assert.throws(() => f.admission.admitPrincipal(principal()));
  assert.throws(() => f.admission.admitResource(actorId));
  f.state.accessReady = true;
  const proof = f.admission.admitPrincipal(principal());
  assert.equal(Atomics.load(proof.resourcePermit, 0), 1);
  f.state.accessReady = false;
  f.notify();
  assert.equal(Atomics.load(proof.resourcePermit, 0), 0);
});
