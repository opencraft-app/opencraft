// Deployment-level stores over the runtime-neutral SQL port (gateway-split.md
// §5.1 G3): the push store, MCP app definitions and managed connectors. Shared
// by the Durable Object prototype (deployment-stores-worker.ts, bundled for
// workerd) and the Node side of the scenarios (nodeSqlDatabase). Each store
// keeps its own published migration chain and ledger, so each runs on its own
// database; every scenario returns plain JSON with clocks and random ids
// normalized, so both runtimes are compared result for result.
import { createHash } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";
import { applySqlMigrations, hashSqlMigrations, type SqlMigration } from "@opencraft/sql/migrations";
import { resolveStoreMigrations, type StorageSchemaId } from "@opencraft/sqlite-node";
import { PUSH_MIGRATIONS, SqlPushStore, type PushBinding } from "@opencraft/web-push-node/sql-store";
import { AppStore, appMigrations } from "../../../packages/mcp-apps/src/store.ts";
import type { AppSpec } from "../../../packages/mcp-apps/src/spec.ts";
import { CONNECTOR_MIGRATIONS, SqlConnectorDatabase } from "@opencraft/connector-host/store";

/** Each store by its `openManagedDatabase` schema id (the registry appends generated migrations). */
const PUBLISHED: Record<DeploymentStore, { id: StorageSchemaId; prefix: readonly SqlMigration[] }> = {
  "web-push-node": { id: "web-push-node", prefix: PUSH_MIGRATIONS },
  "mcp-apps": { id: "mcp-apps", prefix: appMigrations },
  "connector-host": { id: "connector-host", prefix: CONNECTOR_MIGRATIONS },
};
export type DeploymentStore = "web-push-node" | "mcp-apps" | "connector-host";
export const DEPLOYMENT_STORES = Object.keys(PUBLISHED) as DeploymentStore[];

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** The full published chain the Node owner applies, with the checksums its ledger records. */
export function publishedMigrations(store: DeploymentStore) {
  const { id, prefix } = PUBLISHED[store];
  return hashSqlMigrations(resolveStoreMigrations(id, prefix), sha256Hex);
}

/** Applies the chain through the runtime-neutral ledger runner; returns the ledger without timestamps. */
export function migrate(database: SqlDatabase, store: DeploymentStore, limit?: number) {
  const migrations = publishedMigrations(store);
  applySqlMigrations(database, limit === undefined ? migrations : migrations.slice(0, limit));
  return ledger(database);
}
export function ledger(database: SqlDatabase) {
  return database
    .prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => ({ version: Number(row.version), name: String(row.name), checksum: String(row.checksum) }));
}
/** User objects only; runtime-owned tables (`_cf_*`, `sqlite_*`) are excluded. */
export function schema(database: SqlDatabase) {
  return database
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type,name",
    )
    .all()
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
      sql: row.sql === null ? null : String(row.sql),
    }));
}

const lent = (database: SqlDatabase) => ({ database, outcome: null, close() {} });
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Random ids become their first-seen ordinal, so equal ids stay equal across runtimes. */
function normalize(value: unknown): unknown {
  const seen = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value).replace(uuid, (id) => {
      if (!seen.has(id)) seen.set(id, `uuid-${seen.size + 1}`);
      return seen.get(id)!;
    }),
  );
}
/** Runs each step and records its value or error message. */
function recorder() {
  const steps: [string, unknown][] = [];
  return {
    steps,
    step(label: string, work: () => unknown) {
      try {
        const value = work();
        steps.push([label, value === undefined ? null : value]);
      } catch (error) {
        steps.push([label, { error: error instanceof Error ? error.message : String(error) }]);
      }
    },
  };
}

function pushScenario(database: SqlDatabase) {
  let clock = 1_000_000;
  const store = new SqlPushStore(lent(database), { sha256Hex, now: () => clock });
  const { steps, step } = recorder();
  const binding = (actorId: string): PushBinding => ({
    context: { actorId, kind: "human" } as unknown as PushBinding["context"],
  });
  const subscription = { endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } };
  const messages = { title: "done" };
  step("keys", () => store.keys(() => ({ publicKey: "public", privateKey: "private" })));
  step("keys kept", () => store.keys(() => ({ publicKey: "rotated", privateKey: "rotated" })));
  step("register", () =>
    store.register(binding("human-a"), subscription, "https://w.example", "/s", "en-US", messages),
  );
  step("register again keeps binding", () =>
    store.register(binding("human-a"), subscription, "https://w.example", "/s", "en-US", messages),
  );
  step("bark target", () =>
    store.saveTarget(
      binding("human-a"),
      { kind: "bark", url: "https://bark.example/k" },
      "https://w.example",
      "/s",
      "en-US",
      messages,
      undefined,
      "bark-1",
    ),
  );
  step("default im target", () =>
    store.initializeDefault(
      binding("human-a"),
      "policy.default",
      { kind: "im", channelId: "c", senderId: "s", label: "IM" },
      "https://w.example",
      "/s",
      "en-US",
      messages,
    ),
  );
  step("devices", () => store.devices("human-a"));
  step("watch", () => store.watch("human-a", "server", "host", "thread", "input"));
  step("watches", () => store.watches());
  step("bind turn", () => store.watches().forEach((watch) => store.bindTurn(watch.id, "turn")));
  step("finish", () => store.finish(store.watches()[0]!, "turn", "completed"));
  step("finish twice is a no-op", () =>
    store.finish({ ...store.watches()[0]!, id: "gone" } as never, "turn", "completed"),
  );
  // Delivery ids hash a random device id, so deliveries are compared by their device.
  step("due", () => store.due().map(({ id: _id, ...delivery }) => delivery));
  step("retry", () => store.due().forEach((delivery) => store.retry(delivery.id, delivery.attempts + 1)));
  clock += 10_000;
  step("due after back-off", () => store.due().map((delivery) => [delivery.device.id, delivery.attempts]));
  step("settle", () => store.due().forEach((delivery) => store.settled(delivery.id, "sent")));
  step("disable bark", () => {
    const bark = store.devices("human-a").find((device) => device.target?.kind === "bark")!;
    store.setEnabled(bark.id, "human-a", false);
    return store.get(bark.id)?.enabled;
  });
  step("master off", () => {
    store.setMaster("human-a", false);
    return [store.master("human-a"), store.watches().length];
  });
  step("master on; opt-outs block the default", () => {
    store.setMaster("human-a", true);
    store.initializeDefault(
      binding("human-a"),
      "policy.other",
      { kind: "im", channelId: "c2", senderId: "s", label: "IM" },
      "o",
      "/",
      "en-US",
      messages,
    );
    return store.devices("human-a").length;
  });
  step("remove", () => {
    const web = store.devices("human-a").find((device) => device.subscription)!;
    store.remove(web.id, "human-a");
    return store.hasActor("human-a");
  });
  step("invalid policy", () =>
    store.initializeDefault(
      binding("human-a"),
      "bad policy",
      { kind: "im", channelId: "c", senderId: "s", label: "x" },
      "o",
      "/",
      "en",
      {},
    ),
  );
  clock += 8 * 86_400_000;
  step("prune", () => {
    store.prune();
    return database
      .prepare("SELECT (SELECT count(*) FROM push_watches) w, (SELECT count(*) FROM push_deliveries) d")
      .get();
  });
  return normalize(steps);
}

const spec = (title: string): AppSpec =>
  ({
    appId: "calculator",
    title,
    description: "Adds numbers",
    uiHtml: `<p>${title}</p>`,
  }) as unknown as AppSpec;
function appsScenario(database: SqlDatabase) {
  const store = new AppStore(lent(database), { sha256Hex });
  const { steps, step } = recorder();
  const created = (value: unknown) =>
    JSON.parse(JSON.stringify(value ?? null).replace(/"created":\d+/g, '"created":0'));
  step("save draft", () => store.mutate("alice", "calculator", 0, "saveDraft", spec("Draft")));
  step("stale version", () => store.mutate("alice", "calculator", 0, "saveDraft", spec("Stale")));
  step("publish", () => store.mutate("alice", "calculator", 1, "publish", spec("First")));
  step("publish again", () => store.mutate("alice", "calculator", 2, "publish", spec("Second")));
  step("rollback", () => store.mutate("alice", "calculator", 3, "rollback", undefined, 1));
  step("rollback to a missing release", () => store.mutate("alice", "calculator", 4, "rollback", undefined, 9));
  step("revisions", () => created(store.revisions("alice", "calculator")));
  step("release", () => created(store.release("alice", "calculator", 1)));
  step("referenced release", () => {
    const release = store.release("alice", "calculator", 2)!;
    return created(store.referencedRelease(release.uri, "calculator", 2));
  });
  step("list", () => store.list("alice", 0, 10));
  step("other owner is empty", () => store.list("bob", 0, 10));
  step("unpublish", () => store.mutate("alice", "calculator", 4, "unpublish"));
  step("delete cascades nothing left", () => {
    store.mutate("alice", "calculator", 5, "delete");
    return [store.get("alice", "calculator"), store.revisions("alice", "calculator")];
  });
  step("missing app", () => store.mutate("alice", "other", 0, "unpublish"));
  step("foreign key", () => {
    try {
      database.prepare("INSERT INTO releases VALUES('nobody','x',1,'u','{}',0)").run();
      return "accepted";
    } catch {
      return "refused";
    }
  });
  return normalize(steps);
}

function connectorsScenario(database: SqlDatabase) {
  const { steps, step } = recorder();
  const updated = (value: unknown) =>
    JSON.parse(JSON.stringify(value ?? null).replace(/"updatedAt":\d+/g, '"updatedAt":0'));
  database.prepare("INSERT INTO connector_instances VALUES('stale','tencent-docs','stale',1,1,'{}',0)").run();
  database.prepare("INSERT INTO connector_credentials VALUES('stale','{}','{}')").run();
  database
    .prepare(
      "INSERT INTO connector_oauth_transactions VALUES('tx-old','stale',1,'state-old',?,'pending','{\"verifier\":\"v\"}')",
    )
    .run(Date.now() + 600_000);
  const store = new SqlConnectorDatabase(lent(database));
  step("startup cancels pending OAuth", () => ({ ...store.getTransaction("tx-old"), expiresAt: 0 }));
  const input = {
    id: "personal",
    definitionId: "tencent-docs",
    title: "Docs",
    expectedRevision: 0,
    values: {},
    secrets: { token: "synthetic-token" },
  };
  step("save", () => updated(store.save(input)));
  step("save conflict", () => store.save(input));
  step("invalid field", () => store.save({ ...input, id: "bad", values: { token: "leak" }, secrets: {} }));
  step("list hides secrets", () => updated(store.list()));
  step("get", () => updated(store.get("personal")));
  step("disable", () => updated(store.setEnabled("personal", 1, false)));
  step("oauth", () => {
    store.saveOAuth("personal", 2, { tokens: { access_token: "a" } }, true);
    return updated(store.get("personal"));
  });
  step("transaction", () => {
    store.putTransaction({
      id: "tx",
      instanceId: "personal",
      revision: 3,
      state: "state-1",
      expiresAt: Date.now() + 600_000,
      status: "pending",
      data: { verifier: "x" },
    });
    return { ...store.getTransaction("tx"), expiresAt: 0 };
  });
  step("remove stale revision", () => store.remove("personal", 1));
  step("remove cascades credentials", () => {
    store.remove("personal", 3);
    store.remove("stale", 1);
    return database
      .prepare(
        "SELECT (SELECT count(*) FROM connector_credentials) c, (SELECT count(*) FROM connector_oauth_transactions) t",
      )
      .get();
  });
  step("missing", () => store.get("personal"));
  return normalize(steps);
}

export function scenario(database: SqlDatabase, store: DeploymentStore) {
  switch (store) {
    case "web-push-node":
      return pushScenario(database);
    case "mcp-apps":
      return appsScenario(database);
    case "connector-host":
      return connectorsScenario(database);
  }
}
