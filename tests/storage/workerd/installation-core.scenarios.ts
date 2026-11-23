// InstallationCore Durable Object scenarios (docs/architecture/platform/cloudflare-deployment.md
// §5): the Server core migrations run on Durable Object SQL through the
// runtime-neutral ledger runner, reopening validates and applies nothing, a
// tampered checksum is refused, and the unchanged access-control domain stores
// give the same results as on node:sqlite. Run by
// tests/storage/installation-core-workerd.test.ts (Miniflare) and by the real
// Cloudflare rehearsal (scripts/cloudflare/rehearsal.ts).
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openServerDatabase, SERVER_MIGRATIONS } from "@opencraft/storage-node/server";
import { InstallationCoreDomain, type InstallationCoreMethod } from "./installation-core-domain.ts";
import type { WorkerInstance, WorkerRuntime, WorkerScenario, WorkerSpec } from "../../cloudflare/worker-runtime.ts";

export const INSTALLATION_CORE_WORKER: WorkerSpec = {
  id: "core",
  entry: resolve(import.meta.dirname, "installation-core-worker.ts"),
  // node:crypto comes from nodejs_compat; see the Node-only dependency notes in the docs.
  compatibilityFlags: ["nodejs_compat"],
  externalNode: true,
  durableObjects: { CORE: "InstallationCore" },
};

let sequence = 0;
const start = (runtime: WorkerRuntime, persist?: string, migrationLimit?: number) =>
  runtime.start(INSTALLATION_CORE_WORKER, {
    ...(persist ? { persist } : {}),
    ...(migrationLimit ? { vars: { MIGRATION_LIMIT: migrationLimit } } : {}),
  });

type Call = (method: InstallationCoreMethod | "tamperLedger", ...args: unknown[]) => Promise<unknown>;
function client(instance: WorkerInstance, object = `core-${++sequence}`): Call {
  return async (method, ...args) => {
    const response = await instance.fetch("http://core/", {
      method: "POST",
      body: JSON.stringify({ object, method, args }),
    });
    const text = await response.text();
    let outcome: { ok: boolean; value?: unknown; error?: string };
    try { outcome = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`); }
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  };
}

/** One call sequence over the domain stores; ids and secrets are random, so they are normalized below. */
async function scenario(call: (method: InstallationCoreMethod, ...args: unknown[]) => Promise<unknown>) {
  const expiresAt = Date.now() + 3_600_000;
  const steps: Record<string, unknown> = {};
  const step = async (label: string, method: InstallationCoreMethod, ...args: unknown[]) =>
    (steps[label] = await call(method, ...args)) as { ok: boolean; value: any };
  const alice = (
    await step("resolve alice", "resolveHuman", {
      provider: "local",
      subject: "alice",
      displayName: "Alice",
      expiresAt,
    })
  ).value;
  await step("resolve alice again", "resolveHuman", {
    provider: "local",
    subject: "alice",
    displayName: "Alice",
    expiresAt,
  });
  await step("rename alice on login", "resolveHuman", {
    provider: "local",
    subject: "alice",
    displayName: "Alice A.",
    expiresAt,
  });
  const bob = (
    await step("resolve bob", "resolveHuman", { provider: "local", subject: "bob", displayName: "Bob", expiresAt })
  ).value;
  await step("invalid principal", "resolveHuman", { provider: "local", subject: "", displayName: "x", expiresAt });

  const session = (await step("create session", "createSession", "Build bot", alice.actorId)).value;
  await step("credential for a human is refused", "issueCredential", alice.actorId, Date.now() + 60_000, alice.actorId);
  const credential = (
    await step("issue credential", "issueCredential", session.id, Date.now() + 86_400_000, alice.actorId)
  ).value;
  await step("authenticate session", "authenticateSession", credential.token);
  await step(
    "authenticate tampered token",
    "authenticateSession",
    credential.token.slice(0, -1) + (credential.token.endsWith("A") ? "B" : "A"),
  );

  await step("no membership yet", "authenticate", "alice");
  await step("grant alice admin", "setMember", "local", "alice", "admin", true, "local-operator");
  await step("alice is admin", "authenticate", "alice");
  await step("grant bob member", "setMember", "local", "bob", "member", true, "local-operator");
  await step("bob is member", "authenticate", "bob");
  await step("revoke bob", "setMember", "local", "bob", "member", false, "local-operator");
  await step("bob is refused", "authenticate", "bob");
  await step("bob revocation revision", "revocationRevision", bob.actorId, [{ provider: "local", subject: "bob" }]);
  await step("unknown subject", "authenticate", "mallory");
  const members = (await step("members", "members")).value;
  // listActors orders by actor_id, a random UUID; order by role to compare runs.
  members.actors.sort((a: { role: string }, b: { role: string }) => a.role.localeCompare(b.role));

  await step("thread created by alice", "threadCreated", "server", "thread", alice);
  await step("bob cannot change access", "setThreadAccess", "server", "thread", "private", 1, bob);
  await step("alice makes it private", "setThreadAccess", "server", "thread", "private", 1, alice);
  await step("stale revision is refused", "setThreadAccess", "server", "thread", "shared", 1, alice);
  await step("alice allowed", "threadAllows", "server", "thread", alice);
  await step("bob refused", "threadAllows", "server", "thread", bob);
  await step("anonymous refused", "threadAllows", "server", "thread", null);
  await step("other server shared", "threadAllows", "other", "thread", bob);
  await step("creator actor allowed", "threadAllowsActor", "server", "thread", alice.actorId);
  await step("policy", "threadPolicy", "server", "thread");

  await step("revoke credential", "revokeCredential", credential.credentialId, alice.actorId);
  await step("revoked token refused", "authenticateSession", credential.token);
  await step("disable alice", "setActorEnabled", alice.actorId, false, "local-operator");
  await step("disabled alice context", "isCurrent", alice);
  await step("disabled alice thread access", "threadAllows", "server", "thread", alice);
  return steps;
}

/** Replaces random UUIDs, credential secrets and wall-clock fields by stable placeholders. */
function normalize(value: unknown): unknown {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value, (key, field) =>
    ["createdAt", "created_at", "at", "expiresAt", "expires_at"].includes(key) && typeof field === "number"
      ? "<time>"
      : field,
  )
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (uuid) => {
      if (!ids.has(uuid)) ids.set(uuid, `<uuid-${ids.size}>`);
      return ids.get(uuid)!;
    })
    .replace(/(oc_actor_v1\.<uuid-\d+>\.<uuid-\d+>\.)[A-Za-z0-9_-]{42,43}/g, "$1<secret>");
  return JSON.parse(text);
}

export const INSTALLATION_CORE_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "fresh InstallationCore applies every Server migration on Durable Object SQL",
    async run({ runtime }) {
      const call = client(await start(runtime));
      assert.deepEqual(await call("outcome"), { status: "fresh", appliedVersion: SERVER_MIGRATIONS.length });
      const ledger = (await call("ledger")) as { version: number; name: string }[];
      assert.deepEqual(
        ledger.map(({ version, name }) => ({ version, name })),
        SERVER_MIGRATIONS.map(({ version, name }) => ({ version, name })),
      );
      const schema = (await call("schema")) as { type: string; name: string }[];
      // Migration 6 creates triggers with BEGIN…END bodies; workerd accepts them as schema, not transaction control.
      assert.deepEqual(
        schema
          .filter((object) => object.type === "trigger")
          .map((object) => object.name)
          .sort(),
        ["actor_channel_message_inserted", "actor_channel_request_linked"],
      );
    },
  },
  {
    name: "Durable Object and node:sqlite produce the same Server schema",
    async run({ runtime, scratch }) {
      const call = client(await start(runtime));
      const node = await openServerDatabase(await mkdtemp(join(scratch, "node-schema-")));
      try {
        const domain = new InstallationCoreDomain(node);
        assert.deepEqual(await call("schema"), JSON.parse(JSON.stringify(domain.schema())));
        domain.close();
      } finally {
        await node.close();
      }
    },
  },
  {
    name: "reopening persisted storage validates the ledger and applies nothing",
    async run({ runtime }) {
      const persist = `persist-${++sequence}`;
      const first = await start(runtime, persist);
      const object = "reopen";
      const recorded = await client(first, object)("ledger");
      const alice = (await client(first, object)("resolveHuman", {
        provider: "local",
        subject: "alice",
        displayName: "Alice",
        expiresAt: Date.now() + 3_600_000,
      })) as { ok: true; value: { actorId: string } };
      await runtime.stop(first);

      const second = await start(runtime, persist);
      const call = client(second, object);
      assert.deepEqual(await call("outcome"), { status: "up-to-date", appliedVersion: SERVER_MIGRATIONS.length });
      assert.deepEqual(await call("ledger"), recorded, "no ledger row was rewritten or appended");
      assert.equal(
        ((await call("findHuman", "local", "alice")) as { value: { id: string } }).value.id,
        alice.value.actorId,
      );
      await runtime.stop(second);
    },
  },
  {
    name: "a tampered ledger checksum is refused and the object stays closed",
    async run({ runtime }) {
      const persist = `tamper-${++sequence}`;
      const first = await start(runtime, persist);
      assert.equal(await client(first, "tamper")("tamperLedger", 3), 1);
      await runtime.stop(first);

      const second = await start(runtime, persist);
      await assert.rejects(
        client(second, "tamper")("outcome"),
        /InstallationCore is unavailable: SqlMigrationError: Unsupported database migration history/,
      );
      await assert.rejects(client(second, "tamper")("findHuman", "local", "alice"), /InstallationCore is unavailable/);
      await runtime.stop(second);
    },
  },
  {
    name: "an object migrated by an older build applies only the newer migrations after restart",
    async run({ runtime, scratch }) {
      const persist = `upgrade-${++sequence}`;
      // Stop before 0005_native_channels so the restart runs its ALTER TABLE, data copy and triggers.
      const older = 5;
      const first = await start(runtime, persist, older);
      const object = "upgrade";
      assert.deepEqual(await client(first, object)("outcome"), { status: "fresh", appliedVersion: older });
      const recorded = (await client(first, object)("ledger")) as { version: number; applied_at: number }[];
      await runtime.stop(first);

      const second = await start(runtime, persist);
      const call = client(second, object);
      assert.deepEqual(await call("outcome"), { status: "migrated", appliedVersion: SERVER_MIGRATIONS.length });
      const ledger = (await call("ledger")) as { version: number; applied_at: number }[];
      assert.deepEqual(ledger.slice(0, older), recorded, "earlier ledger rows are kept as recorded");
      assert.equal(ledger.length, SERVER_MIGRATIONS.length);
      const node = await openServerDatabase(await mkdtemp(join(scratch, "node-upgrade-")));
      try {
        const domain = new InstallationCoreDomain(node);
        assert.deepEqual(
          await call("schema"),
          JSON.parse(JSON.stringify(domain.schema())),
          "upgraded schema equals a fresh Node schema",
        );
        domain.close();
      } finally {
        await node.close();
      }
      await runtime.stop(second);
    },
  },
  {
    name: "an object migrated by a newer build is refused by an older one",
    async run({ runtime }) {
      const persist = `newer-${++sequence}`;
      const current = await start(runtime, persist);
      await client(current, "newer")("outcome");
      await runtime.stop(current);

      const older = await start(runtime, persist, SERVER_MIGRATIONS.length - 1);
      await assert.rejects(
        client(older, "newer")("outcome"),
        /InstallationCore is unavailable: SqlMigrationError: Unsupported newer database migration history/,
      );
      await runtime.stop(older);
    },
  },
  {
    name: "domain RPC round trips match the Node owner for the same inputs",
    async run({ runtime, scratch }) {
      const call = client(await start(runtime));
      const workerd = await scenario((method, ...args) => call(method, ...args));

      const node = await openServerDatabase(await mkdtemp(join(scratch, "node-domain-")));
      let local: Record<string, unknown>;
      try {
        const domain = new InstallationCoreDomain(node);
        // Structured clone over RPC drops frozen-ness and class identity; JSON does the same here.
        local = await scenario(async (method, ...args) =>
          JSON.parse(JSON.stringify((domain[method] as (...values: unknown[]) => unknown).apply(domain, args))),
        );
        domain.close();
      } finally {
        await node.close();
      }
      assert.deepEqual(normalize(workerd), normalize(local));
      // Spot-check that the scenario exercised real outcomes, not uniform failures.
      const steps = normalize(workerd) as Record<string, { ok: boolean; value?: unknown; code?: number }>;
      assert.deepEqual(steps["alice is admin"]!.value, {
        principal: { provider: "local", subject: "alice" },
        role: "admin",
        admission: 204,
      });
      assert.deepEqual(steps["bob is refused"]!.value, {
        principal: { provider: "local", subject: "bob" },
        role: null,
        admission: 403,
      });
      assert.equal(steps["stale revision is refused"]!.code, -32009);
      assert.equal(steps["bob refused"]!.value, false);
      assert.equal(steps["revoked token refused"]!.value, null);
    },
  },
];

