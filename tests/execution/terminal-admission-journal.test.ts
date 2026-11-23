import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalAdmissionStore } from "../../apps/local-agent-host/src/terminal-admission-store.js";
import { TerminalAdmissionStore as ReleasedV1Store } from "../fixtures/terminal-admission-store-v1.js";

const journal = (directory: string) => join(directory, "terminal-admission.json");
const read = async (directory: string) => JSON.parse(await readFile(journal(directory), "utf8"));
const token = (n: number) => String(n).padStart(64, "a");
const launch = (incarnation: string) => ({
  account: "actor:human://fixture/one",
  actorGeneration: 3,
  membershipRevision: 7,
  hostId: "opencraft-server" as const,
  threadId: "thread",
  incarnation,
});
async function directory(t: test.TestContext) {
  const path = await mkdtemp(join(tmpdir(), "terminal-journal-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("a v1 journal opens unchanged and a held launch admission records the Actor epoch and owner incarnation in v2", async (t) => {
  const dir = await directory(t);
  const v1 = {
    version: 1,
    reservations: [
      { token: token(1), kind: "local", quotaOwner: "owner-a", resource: "old-incarnation", operation: "kept" },
      { token: token(2), kind: "remote", quotaOwner: "owner-a", resource: "sandbox", operation: "op" },
    ],
  };
  await writeFile(journal(dir), JSON.stringify(v1), { mode: 0o600 });
  const store = await TerminalAdmissionStore.open(dir);
  // Opening without a change does not rewrite the journal.
  assert.deepEqual(await read(dir), v1);
  await store.reserve("local", "owner-a", "incarnation", "handle", launch("incarnation"));
  const upgraded = await read(dir);
  assert.equal(upgraded.version, 2);
  assert.deepEqual(upgraded.reservations.slice(0, 2), v1.reservations, "v1 rows are carried over unchanged");
  assert.deepEqual(upgraded.reservations[2].launch, launch("incarnation"));
  assert.deepEqual((await store.held("incarnation", "handle"))!.launch, launch("incarnation"));
  // Launching is the durable one-shot fence, and the journal returns to v1.
  const receipt = await store.launch("incarnation", "handle", "owner-a");
  assert.match(receipt, /^[a-f0-9]{64}$/u);
  assert.equal(await store.held("incarnation", "handle"), null);
  await assert.rejects(store.launch("incarnation", "handle", "owner-a"), /not admissible/);
  const after = await read(dir);
  assert.equal(after.version, 1);
  assert.ok(after.reservations.every((row: object) => !Object.hasOwn(row, "launch")));
  assert.equal(after.reservations.length, 3, "a launched reservation still holds capacity");
  await store.close();
});

test("held, foreign-owner, malformed and remote launch admissions are refused", async (t) => {
  const dir = await directory(t);
  const store = await TerminalAdmissionStore.open(dir);
  t.after(() => store.close());
  await assert.rejects(store.reserve("remote", "owner", "incarnation", "op", launch("incarnation")), /Invalid/);
  await assert.rejects(store.reserve("local", "owner", "incarnation", "op", launch("other")), /Invalid/);
  await assert.rejects(
    store.reserve("local", "owner", "incarnation", "op", { ...launch("incarnation"), projectId: "p" }),
    /Invalid/,
  );
  await assert.rejects(
    store.reserve("local", "owner", "incarnation", "op", { ...launch("incarnation"), account: "alice" }),
    /Invalid/,
  );
  await store.reserve("local", "owner", "incarnation", "op", launch("incarnation"));
  await assert.rejects(store.reserve("local", "owner", "incarnation", "op", launch("incarnation")), /do not replay/);
  await assert.rejects(store.launch("incarnation", "op", "someone-else"), /not admissible/);
  assert.equal(await store.abandon("incarnation", "op"), true);
  assert.equal(await store.abandon("incarnation", "op"), false);
  await assert.rejects(store.launch("incarnation", "op", "owner"), /not admissible/);
  assert.equal((await read(dir)).reservations.length, 0, "an abandoned reservation releases its capacity");
});

test("a restarted owner releases held admissions of its earlier incarnation; launched ones stay reserved", async (t) => {
  const dir = await directory(t);
  const first = await TerminalAdmissionStore.open(dir);
  await first.reserve("local", "owner", "first", "launched", launch("first"));
  await first.launch("first", "launched", "owner");
  await first.reserve("local", "owner", "first", "held", launch("first"));
  // Crash: close without settling.
  await first.close();
  assert.equal((await read(dir)).version, 2);
  const second = await TerminalAdmissionStore.open(dir);
  t.after(() => second.close());
  const rows = (await read(dir)).reservations;
  assert.equal((await read(dir)).version, 1);
  assert.deepEqual(
    rows.map((row: { operation: string }) => row.operation),
    ["launched"],
    "held means nothing was launched: it is released, never relaunched",
  );
  assert.equal(await second.held("first", "held"), null);
});

test("rollback: the released v1 owner refuses a v2 journal and opens the v1 journal written once nothing is held", async (t) => {
  const dir = await directory(t);
  const store = await TerminalAdmissionStore.open(dir);
  await store.reserve("local", "owner", "incarnation", "kept", undefined);
  await store.reserve("local", "owner", "incarnation", "held", launch("incarnation"));
  assert.equal((await read(dir)).version, 2);
  await assert.rejects(ReleasedV1Store.open(dir), /Invalid terminal admission journal/, "an old owner fails closed");
  assert.equal((await read(dir)).version, 2, "the refused journal is left untouched");
  await store.abandon("incarnation", "held");
  await store.close();
  const old = await ReleasedV1Store.open(dir);
  await old.release(JSON.parse(await readFile(journal(dir), "utf8")).reservations[0].token);
  await old.close();
  assert.deepEqual(await read(dir), { version: 1, reservations: [] });
  // Restarting the current owner on the v2 leftovers of a crash downgrades too.
  const crashed = await TerminalAdmissionStore.open(dir);
  await crashed.reserve("local", "owner", "incarnation-2", "held", launch("incarnation-2"));
  await crashed.close();
  await assert.rejects(ReleasedV1Store.open(dir));
  await (await TerminalAdmissionStore.open(dir)).close();
  await (await ReleasedV1Store.open(dir)).close();
});
