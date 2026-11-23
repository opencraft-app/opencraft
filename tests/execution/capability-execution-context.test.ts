import test from "node:test";
import assert from "node:assert/strict";
import { SessionCapabilities, type CapabilitySession } from "../../packages/session-capabilities/src/index.js";
import {
  createCapabilityContextResolver,
  type CapabilityContextOwners,
} from "../../apps/headless-server/src/capability-execution-context.js";

const tool = { name: "probe", description: "Probe", inputSchema: { type: "object" } };
const signal = () => new AbortController().signal;
const host = { id: "opencraft-server", engine: "dsh" };
const actorContext = {
  actorId: "human://local/alice",
  generation: 3,
  credentialId: null,
  expiresAt: Date.now() + 60_000,
};

test("callers cannot supply execution context and no resolver means no context", async () => {
  const service = new SessionCapabilities(),
    seen: CapabilitySession[] = [];
  service.register({
    id: "probe",
    tools: (session) => (seen.push(session), [tool]),
    async call(session) {
      seen.push(session);
      return "ok";
    },
  });
  const forged = {
    serverId: "server",
    threadId: "thread",
    execution: { inputId: "input" },
    context: { host: { id: "forged", engine: "forged" }, actor: { id: "forged", generation: 1, bindings: [] } },
  };
  service.tools(forged);
  await service.call(forged, "probe", {}, signal());
  assert.equal(seen.length, 3);
  for (const session of seen) {
    assert.equal("context" in session, false);
    assert.deepEqual(session.execution, { inputId: "input" });
  }
});

test("refresh, catalog and call receive the core-resolved context; calls resolve afresh", async () => {
  const service = new SessionCapabilities(),
    calls: unknown[] = [],
    seen: (CapabilitySession["context"] | undefined)[] = [];
  let actorId = "human://local/alice";
  service.resolveContext(async (session) => {
    calls.push(session);
    return { host, actor: { id: actorId, generation: 3, bindings: [{ provider: "oidc", subject: "alice" }] } };
  });
  assert.throws(() => service.resolveContext(async () => undefined), /already installed/);
  service.register({
    id: "probe",
    async refresh(session) {
      seen.push(session.context);
    },
    tools: (session) => (seen.push(session.context), session.context?.actor ? [tool] : []),
    async call(session) {
      seen.push(session.context);
      assert.ok(Object.isFrozen(session.context));
      return session.context?.actor?.id;
    },
  });
  const session = {
    serverId: "server",
    threadId: "thread",
    execution: { inputId: "input", callId: "a" },
    context: { host: { id: "forged", engine: "forged" } },
  };
  assert.deepEqual(service.tools(session), []);
  await service.refresh(session);
  assert.equal("context" in (calls[0] as object), false);
  // The catalog key ignores per-call identity.
  assert.deepEqual(
    service.tools({ ...session, execution: { inputId: "input", callId: "b" } }).map((t) => t.name),
    ["probe"],
  );
  actorId = "human://local/bob";
  const result = await service.call(session, "probe", {}, signal());
  assert.equal(JSON.parse((result.contentItems[0] as { text: string }).text), "human://local/bob");
  assert.equal(calls.length, 2);
  assert.equal(
    seen.filter(Boolean).every((context) => context!.host.id === "opencraft-server"),
    true,
  );
  const port = service.scoped("server");
  await port.refresh!("other", { turnId: "turn" });
  assert.deepEqual(
    port.tools("other").map((t) => t.name),
    ["probe"],
  );
});

function owners(overrides: Partial<CapabilityContextOwners> = {}): CapabilityContextOwners & { leases: unknown[] } {
  const leases: unknown[] = [];
  return {
    leases,
    route: (serverId) => (serverId === "server:m:dsh" ? { hostId: "opencraft-server", engine: "dsh" } : undefined),
    source: async () => ({ context: actorContext }),
    current: () => true,
    bindings: () => [{ provider: "oidc", subject: "alice" }],
    lease: async (locator) => {
      leases.push(locator);
      return {
        scope: {
          account: `actor:${actorContext.actorId}`,
          hostId: "opencraft-server",
          threadId: "thread",
          inputId: "input",
          executionId: "execution",
          leaseGeneration: 2,
          actorGeneration: 3,
          membershipRevision: 0,
          projectId: null,
        },
        authority: "authority",
        capability: "sealed",
        native: { turnId: "turn", incarnation: "incarnation" },
      };
    },
    ...overrides,
  };
}
const run = { serverId: "server:m:dsh", threadId: "thread", execution: { inputId: "input" } };

test("resolver reports host, verified actor and active lease from core owners", async () => {
  const fixture = owners();
  const context = await createCapabilityContextResolver(fixture)(run);
  assert.deepEqual(context, {
    host,
    actor: { id: actorContext.actorId, generation: 3, bindings: [{ provider: "oidc", subject: "alice" }] },
    lease: { inputId: "input", executionId: "execution", generation: 2, turnId: "turn", incarnation: "incarnation" },
  });
  assert.deepEqual(fixture.leases, [{ hostId: "opencraft-server", threadId: "thread", inputId: "input" }]);
  assert.equal("capability" in context!.lease!, false);
});

test("resolver omits parts core cannot verify instead of defaulting them", async () => {
  const resolve = (
    o: Partial<CapabilityContextOwners>,
    session: Parameters<ReturnType<typeof createCapabilityContextResolver>>[0] = run,
  ) => createCapabilityContextResolver(owners(o))(session);
  assert.equal(await resolve({}, { ...run, serverId: "server:m:unknown" }), undefined);
  assert.deepEqual(await resolve({}, { serverId: run.serverId, threadId: "thread" }), { host });
  assert.deepEqual(
    await resolve({
      source: async () => {
        throw new Error("execution_delegation_revoked");
      },
    }),
    { host },
  );
  assert.deepEqual(await resolve({ current: () => false }), { host });
  let checks = 0;
  assert.deepEqual(await resolve({ current: () => ++checks === 1 }), { host });
  const withoutLease = async (o: Partial<CapabilityContextOwners>, session = run) => {
    const context = await resolve(o, session);
    assert.ok(context?.actor);
    assert.equal(context.lease, undefined);
  };
  await withoutLease({ lease: undefined });
  await withoutLease({ lease: async () => null });
  await withoutLease({
    lease: async () => {
      throw new Error("git_execution_unavailable");
    },
  });
  await withoutLease({ bindings: () => [], source: async () => ({ context: { ...actorContext, generation: 4 } }) });
  await withoutLease({}, { ...run, execution: { inputId: "input", executionId: "other" } as typeof run.execution });
  await withoutLease({}, { ...run, execution: { inputId: "input", incarnation: "old" } as typeof run.execution });
  await withoutLease({ route: () => ({ hostId: "remote-host", engine: "codex" }) });
});
