// Conversation resource rows on Durable Object SQL (Miniflare, no Cloudflare
// account): the published Server migrations including 0023_conversation_resources
// run unchanged, the runtime-neutral domain gives the same results as the Node
// owner, an older Server contract upgrades across a restart keeping its rows,
// and a tampered checksum is refused. See workspace-host-split.md §4.1.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { openServerDatabase, SERVER_MIGRATIONS } from "@opencraft/storage-node/server";
import { conversationResourceMethods } from "@opencraft/storage-node/server-conversation-resources";

const COMPATIBILITY_DATE = "2026-07-30";
const RESOURCES_VERSION = SERVER_MIGRATIONS.findIndex((migration) => migration.name === "0023_conversation_resources") + 1;
let directory: string;
let script: string;
let sequence = 0;
const running = new Set<Miniflare>();

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "conversation-resources-workerd-"));
  const outfile = join(directory, "worker.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "workerd/conversation-resources-worker.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  });
  script = await readFile(outfile, "utf8");
});
after(async () => {
  for (const miniflare of running) await miniflare.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function start(persist?: string, migrationLimit?: number): Miniflare {
  const miniflare = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CORE: { className: "ResourcesObject", useSQLite: true } },
    ...(migrationLimit ? { bindings: { MIGRATION_LIMIT: migrationLimit } } : {}),
    ...(persist ? { durableObjectsPersist: persist } : {}),
  });
  running.add(miniflare);
  return miniflare;
}
async function stop(miniflare: Miniflare) {
  running.delete(miniflare);
  await miniflare.dispose();
}
function client(miniflare: Miniflare, object = `core-${++sequence}`) {
  return async (method: string, ...args: unknown[]): Promise<any> => {
    const response = await miniflare.dispatchFetch("http://core/", { method: "POST", body: JSON.stringify({ object, method, args }) });
    const outcome = (await response.json()) as { ok: boolean; value?: unknown; error?: string };
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  };
}

const owners = { owners: ["terminal", "browser", "workspace"] };
const row = (threadId: string, state: string, generation: number, pending: string[]) => ({ hostId: "h", threadId, state, generation, pending });
/** One call sequence; each step records its value or error message so both runtimes compare equal. */
async function scenario(call: (method: string, ...args: unknown[]) => Promise<unknown>) {
  const steps: [string, unknown][] = [];
  const step = async (label: string, method: string, ...args: unknown[]) => {
    try {
      steps.push([label, await call(method, ...args)]);
    } catch (error) {
      steps.push([label, { error: (error as Error).message }]);
    }
  };
  await step("open empty", "openConversationResources", owners);
  await step("archive intent", "putConversationResources", [row("a", "archived", 1, ["terminal", "browser"]), row("b", "active", 1, [])]);
  await step("partial acknowledgement", "putConversationResources", [row("a", "archived", 1, ["browser"])]);
  await step("invalid generation refused", "putConversationResources", [row("b", "deleted", 3, []), row("a", "active", 0, [])]);
  await step("advance", "putConversationResources", [row("a", "active", 2, [])]);
  await step("older generation refused atomically", "putConversationResources", [row("b", "active", 2, []), row("a", "archived", 1, [])]);
  await step("unknown owner refused on open", "openConversationResources", { owners: ["terminal"] });
  await step("reopen", "openConversationResources", owners);
  return steps;
}

test("conversation resource rows: published migrations and domain results match the Node owner", async () => {
  const call = client(start());
  const ledger = await call("ledger");
  assert.deepEqual(ledger.map((entry: { name: string }) => entry.name), SERVER_MIGRATIONS.map((migration) => migration.name));
  const onDurableObject = await scenario(call);

  const root = await mkdtemp(join(directory, "node-"));
  const owner = await openServerDatabase(root);
  try {
    const methods = conversationResourceMethods(owner.database);
    const onNode = await scenario(async (method, ...args) => (methods as any)[method](...args));
    assert.deepEqual(onDurableObject, onNode);
    assert.deepEqual(onNode.at(-1)![1], [row("a", "active", 2, []), row("b", "active", 1, [])]);
    assert.deepEqual(ledger, owner.database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all().map((entry) => ({ ...entry })));
  } finally {
    await owner.close();
  }
});

test("conversation resource rows: an older Server contract upgrades across a restart and a tampered checksum is refused", async () => {
  const persist = await mkdtemp(join(directory, "persist-"));
  let miniflare = start(persist, RESOURCES_VERSION - 1);
  let call = client(miniflare, "upgrade");
  assert.equal((await call("ledger")).length, RESOURCES_VERSION - 1);
  await call("sql", "INSERT INTO conversation_creation_receipts(actor_id, operation_key, server_id, fingerprint, state) VALUES('a', 'k', 's', 'f', 'claimed')");
  await stop(miniflare);

  miniflare = start(persist);
  call = client(miniflare, "upgrade");
  assert.equal((await call("ledger")).length, SERVER_MIGRATIONS.length);
  assert.deepEqual(await call("sql", "SELECT state FROM conversation_creation_receipts"), [{ state: "claimed" }]);
  await call("putConversationResources", [row("t", "archived", 1, ["browser"])]);
  await stop(miniflare);

  miniflare = start(persist);
  call = client(miniflare, "upgrade");
  assert.deepEqual(await call("openConversationResources", owners), [row("t", "archived", 1, ["browser"])], "a restart applies nothing and keeps rows");
  assert.equal(await call("tamperLedger", RESOURCES_VERSION), 1);
  await stop(miniflare);

  miniflare = start(persist);
  await assert.rejects(client(miniflare, "upgrade")("ledger"), /unavailable/);
  await stop(miniflare);
});
