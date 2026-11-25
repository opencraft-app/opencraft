import { projectToAppServer, type CanonicalEvent } from "@opencraft/agent-bridge-assembler";
import type { SqlDatabase } from "@opencraft/sql";
import type { SqlMigration } from "@opencraft/sql/migrations";
import { isOutboxId, type OutboxEvent, type OutboxFence } from "./types.js";

export class BridgeInboxRefusal extends Error {}

/** The same inbox on a database shared with other WorkspaceHost owners. */
export const WORKSPACE_BRIDGE_INBOX_MIGRATIONS: readonly SqlMigration[] = [
  {
    version: 1,
    name: "workspace-bridge-inbox",
    sql: `
CREATE TABLE bridge_inbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO bridge_inbox_meta VALUES ('ack','0');
CREATE TABLE bridge_inbox (seq INTEGER PRIMARY KEY, route TEXT NOT NULL, generation TEXT NOT NULL, payload TEXT NOT NULL, projection TEXT NOT NULL) STRICT;
`,
  },
  {
    version: 2,
    name: "workspace-bridge-producer-placement",
    sql: `
CREATE TABLE bridge_inbox_archive (
  placement TEXT NOT NULL, outbox_id TEXT NOT NULL, seq INTEGER NOT NULL,
  route TEXT NOT NULL, generation TEXT NOT NULL, payload TEXT NOT NULL, projection TEXT NOT NULL,
  PRIMARY KEY (placement, seq)
) STRICT;
`,
  },
];

/**
 * The existing gateway inbox transaction over its owner's migrated SQL
 * connection. Publishers may acknowledge only after `apply` returns.
 */
export function createBridgeInboxStore(database: SqlDatabase, scope: "standalone" | "workspace" = "standalone") {
  const metaTable = scope === "workspace" ? "bridge_inbox_meta" : "meta";
  const inboxTable = scope === "workspace" ? "bridge_inbox" : "inbox";
  const cursorRow = database.prepare(`SELECT value FROM ${metaTable} WHERE key='ack'`);
  const updateCursor = database.prepare(`UPDATE ${metaTable} SET value=? WHERE key='ack'`);
  const sourceRow = database.prepare(`SELECT value FROM ${metaTable} WHERE key='inbox-source'`);
  const pinSource = database.prepare(`INSERT INTO ${metaTable} (key,value) VALUES ('inbox-source',?)`);
  const existing = database.prepare(`SELECT route,generation,payload FROM ${inboxTable} WHERE seq=?`);
  const insert = database.prepare(
    `INSERT INTO ${inboxTable} (seq,route,generation,payload,projection) VALUES (?,?,?,?,?)`,
  );
  const page = database.prepare(
    `SELECT seq,route,generation,payload,projection FROM ${inboxTable} WHERE seq>? ORDER BY seq LIMIT 256`,
  );
  const cursor = () => Number(cursorRow.get()!.value);

  return {
    cursor,
    apply(batch: readonly OutboxEvent[], fence?: OutboxFence): { cursor: number; inserted: OutboxEvent[] } {
      return database.transaction(() => {
        const previousCursor = cursor();
        let position = previousCursor;
        const source = sourceRow.get()?.value;
        if (fence) {
          const { outboxId, acknowledged, high } = fence;
          if (
            !isOutboxId(outboxId) ||
            !Number.isSafeInteger(acknowledged) ||
            acknowledged < 0 ||
            !Number.isSafeInteger(high) ||
            acknowledged > position ||
            position > high
          )
            throw new BridgeInboxRefusal("Inbox cursor is outside the producer's retained outbox");
          if ((!source && position !== 0) || (source && source !== outboxId))
            throw new BridgeInboxRefusal("Inbox source could not be confirmed");
          if (!source) pinSource.run(outboxId);
          if ((!batch.length && position < high) || batch.some((row) => row.seq > high))
            throw new BridgeInboxRefusal("Outbox batch does not match its producer fence");
        } else if (source) {
          throw new BridgeInboxRefusal("Fenced inbox requires producer evidence");
        }
        const inserted: OutboxEvent[] = [];
        for (const row of batch) {
          const encoded = JSON.stringify(row.payload);
          if (encoded === undefined) throw new BridgeInboxRefusal("Invalid outbox payload");
          if (row.seq <= position) {
            const previous = existing.get(row.seq);
            if (
              !previous ||
              previous.route !== row.route ||
              previous.generation !== row.generation ||
              previous.payload !== encoded
            )
              throw new BridgeInboxRefusal("Conflicting replay");
            continue;
          }
          if (row.seq !== position + 1) throw new BridgeInboxRefusal("Outbox sequence gap");
          const payload = row.payload as { kind?: string; event?: CanonicalEvent } | null;
          const projection =
            payload?.kind === "canonical"
              ? projectToAppServer([{ ...payload.event!, threadId: JSON.parse(row.route)[1] }], {
                  steerEvidenceDeclared: false,
                  schemaVersion: 1,
                })
              : [];
          insert.run(row.seq, row.route, row.generation, encoded, JSON.stringify(projection));
          position = row.seq;
          inserted.push(row);
        }
        if (position !== previousCursor) updateCursor.run(String(position));
        return { cursor: position, inserted };
      });
    },
    read(after = 0): OutboxEvent[] {
      return page.all(after).map((row) => ({
        seq: Number(row.seq),
        route: String(row.route),
        generation: String(row.generation),
        payload: JSON.parse(String(row.payload)),
        ...(row.projection ? { projection: JSON.parse(String(row.projection)) } : {}),
      }));
    },
  };
}

/** The WorkspaceHost may rebind its inbox after it verifies a new sandbox receipt. */
export function createWorkspaceBridgeInboxStore(database: SqlDatabase) {
  const inbox = createBridgeInboxStore(database, "workspace");
  const meta = database.prepare("SELECT value FROM bridge_inbox_meta WHERE key=?");
  const setMeta = database.prepare(`INSERT INTO bridge_inbox_meta (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  const archive = database.prepare(`INSERT INTO bridge_inbox_archive
    (placement,outbox_id,seq,route,generation,payload,projection)
    SELECT ?,?,seq,route,generation,payload,projection FROM bridge_inbox WHERE seq>?`);
  const retire = database.prepare("DELETE FROM bridge_inbox WHERE seq>?");
  const placement = () => meta.get("producer-placement")?.value as string | undefined;

  return {
    cursor: inbox.cursor,
    read: inbox.read,
    placement,
    adoptPlacement(receipt: string | undefined) {
      // Version 1 already fenced its source and wrote the provider receipt
      // before reading it. Adopt that receipt before a new container can boot.
      if (receipt && !placement() && meta.get("inbox-source")) setMeta.run("producer-placement", receipt);
    },
    apply(
      receipt: string,
      restoredFrom: string | undefined,
      from: number,
      batch: readonly OutboxEvent[],
      fence: OutboxFence,
    ) {
      return database.transaction(() => {
        const previous = placement();
        if (previous && previous !== receipt) {
          const source = meta.get("inbox-source")?.value;
          const cursor = inbox.cursor();
          const sameSource = source === fence.outboxId;
          if (typeof source !== "string" || fence.acknowledged !== from || (sameSource ? from > cursor : from !== 0))
            throw new BridgeInboxRefusal("Replacement producer checkpoint could not be confirmed");
          const checkpoint = sameSource && !restoredFrom ? cursor : from;
          // The producer only acknowledges committed events. Its snapshot's
          // acknowledged prefix is shared with us. Keep the divergent suffix
          // for history while removing it from the live producer projection.
          if (checkpoint < cursor) {
            archive.run(previous, source, checkpoint);
            retire.run(checkpoint);
            setMeta.run("ack", String(checkpoint));
          }
          if (!sameSource) setMeta.run("inbox-source", fence.outboxId);
        }
        const result = inbox.apply(batch, fence);
        if (previous !== receipt) setMeta.run("producer-placement", receipt);
        return result;
      });
    },
  };
}
