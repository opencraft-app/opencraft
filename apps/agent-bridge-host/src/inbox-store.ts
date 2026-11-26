import { projectToAppServer, type CanonicalEvent } from "@opencraft/agent-bridge-assembler";
import { BRIDGE_OUTBOX_PAGE_BYTES } from "@opencraft/agent-bridge-protocol";
import type { SqlDatabase, SqlRow } from "@opencraft/sql";
import type { SqlMigration } from "@opencraft/sql/migrations";
import { isOutboxId, type BridgeHistorySelection, type OutboxEvent, type OutboxFence } from "./types.js";

export class BridgeInboxRefusal extends Error {}

export const HISTORY_IDENTITIES = "json_extract(payload,'$.event.kind') IN ('turn.started','item.started','item.completed')";
const HISTORY_TURN = "json_extract(payload,'$.event.kind') = 'turn.started'";
const HISTORY_PUBLIC_TURN_ID = "json_extract(payload,'$.event.turnId')";
const HISTORY_NATIVE_ID = `CASE WHEN ${HISTORY_TURN}
  THEN json_extract(payload,'$.event.nativeTurnId') ELSE json_extract(payload,'$.event.item.nativeKey') END`;
const INTERACTION_REQUEST = "json_extract(payload,'$.method') = 'interaction/request'";
const INTERACTION_ID = "json_extract(payload,'$.params.interactionId')";
const ROUTE_PROJECTION = `(${HISTORY_IDENTITIES}
  OR ${INTERACTION_REQUEST})`;

export interface BridgeInboxIdentity {
  readonly seq: number;
  readonly turn?: { nativeId: string; id: string };
  readonly item?: { nativeId: string; id: string };
}

export interface BridgeInboxPendingInteraction {
  readonly seq: number;
  readonly id: string;
  readonly params: Record<string, unknown>;
}

export const HISTORY_IDENTITY_COLUMNS = `seq, json_extract(payload,'$.event.kind') AS kind,
  json_extract(payload,'$.event.nativeTurnId') AS native_turn, json_extract(payload,'$.event.turnId') AS turn_id,
  json_extract(payload,'$.event.item.nativeKey') AS native_item, json_extract(payload,'$.event.item.itemId') AS item_id`;

export function historyIdentity(row: SqlRow): BridgeInboxIdentity {
  return {
    seq: Number(row.seq),
    ...(row.kind === "turn.started" && typeof row.native_turn === "string" && typeof row.turn_id === "string"
      ? { turn: { nativeId: row.native_turn, id: row.turn_id } } : {}),
    ...(typeof row.native_item === "string" && typeof row.item_id === "string"
      ? { item: { nativeId: row.native_item, id: row.item_id } } : {}),
  };
}

export function prepareSelectedHistory(database: SqlDatabase, table: "outbox" | "inbox" | "bridge_inbox") {
  // The route/sequence index can satisfy ORDER BY by scanning an entire Thread.
  // Seek within each identity index before merging the bounded sequence pages.
  const statement = database.prepare(`SELECT ${HISTORY_IDENTITY_COLUMNS} FROM ${table} WHERE seq IN (
    SELECT seq FROM (
      SELECT seq FROM ${table} INDEXED BY ${table}_history_native_id
      WHERE route=? AND ${HISTORY_IDENTITIES}
        AND (${HISTORY_NATIVE_ID}) IN (SELECT value FROM json_each(?)) AND seq>? AND seq<=?
      ORDER BY seq LIMIT 256
    )
    UNION
    SELECT seq FROM (
      SELECT seq FROM ${table} INDEXED BY ${table}_history_public_turn
      WHERE route=? AND ${HISTORY_TURN}
        AND ${HISTORY_PUBLIC_TURN_ID} IN (SELECT value FROM json_each(?)) AND seq>? AND seq<=?
      ORDER BY seq LIMIT 256
    )
  ) ORDER BY seq LIMIT 256`);
  return (route: string, after: number, through: number, selection: BridgeHistorySelection) => {
    const publicTurns = selection.publicTurnId === undefined
      ? selection.publicTurnIds ?? []
      : [selection.publicTurnId, ...(selection.publicTurnIds ?? [])];
    return statement.all(
      route, JSON.stringify(selection.nativeIds), after, through,
      route, JSON.stringify(publicTurns), after, through,
    ).map(historyIdentity);
  };
}

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
  {
    version: 3,
    name: "workspace-bridge-route-projection",
    sql: `CREATE INDEX bridge_inbox_route_projection ON bridge_inbox(route,seq) WHERE ${ROUTE_PROJECTION};`,
  },
  {
    version: 4,
    name: "workspace-bridge-large-events",
    sql: `
CREATE TABLE bridge_inbox_chunks (
  placement TEXT NOT NULL, seq INTEGER NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL,
  PRIMARY KEY (placement, seq, part)
) STRICT;
`,
  },
  {
    version: 5,
    name: "workspace-bridge-history-selection-indexes",
    sql: `
CREATE INDEX bridge_inbox_history_native_id ON bridge_inbox(route, (${HISTORY_NATIVE_ID}), seq)
  WHERE ${HISTORY_IDENTITIES};
CREATE INDEX bridge_inbox_history_public_turn ON bridge_inbox(route, ${HISTORY_PUBLIC_TURN_ID}, seq)
  WHERE ${HISTORY_TURN};
`,
  },
];

function projectionFor(payload: unknown, route: string) {
  const row = payload as { kind?: string; event?: CanonicalEvent } | null;
  return row?.kind === "canonical"
    ? projectToAppServer([{ ...row.event!, threadId: JSON.parse(route)[1] }], {
        steerEvidenceDeclared: false,
        schemaVersion: 1,
      })
    : [];
}

/** Keep only fields queried by the partial route index on the primary row. */
function indexedPayload(payload: unknown): string {
  const row = payload as {
    event?: { kind?: string; nativeTurnId?: string; turnId?: string; item?: { nativeKey?: string; itemId?: string } };
    method?: string;
    params?: { interactionId?: string };
  } | null;
  if (row?.event) {
    const { kind, nativeTurnId, turnId, item } = row.event;
    return JSON.stringify({ event: { kind, nativeTurnId, turnId, item: item && { nativeKey: item.nativeKey, itemId: item.itemId } } });
  }
  return JSON.stringify({ method: row?.method, params: { interactionId: row?.params?.interactionId } });
}

function createWorkspaceBridgeChunks(database: SqlDatabase) {
  const insert = database.prepare("INSERT INTO bridge_inbox_chunks VALUES ('',?,?,?)");
  const read = database.prepare("SELECT bytes FROM bridge_inbox_chunks WHERE placement='' AND seq=? ORDER BY part");
  const archive = database.prepare("UPDATE bridge_inbox_chunks SET placement=? WHERE placement='' AND seq>?");
  const chunkBytes = 1024 * 1024;
  return {
    write(seq: number, payload: string) {
      const bytes = new TextEncoder().encode(payload);
      for (let offset = 0; offset < bytes.length; offset += chunkBytes)
        insert.run(seq, offset / chunkBytes, bytes.slice(offset, offset + chunkBytes));
    },
    read(seq: number) {
      const decoder = new TextDecoder();
      const decoded: string[] = [];
      for (const row of read.iterate(seq)) decoded.push(decoder.decode(row.bytes as Uint8Array, { stream: true }));
      if (!decoded.length) throw new BridgeInboxRefusal("Missing retained outbox event chunks");
      decoded.push(decoder.decode());
      return decoded.join("");
    },
    archive: (placement: string, after: number) => archive.run(placement, after),
  };
}

/**
 * The existing gateway inbox transaction over its owner's migrated SQL
 * connection. Publishers may acknowledge only after `apply` returns.
 */
export function createBridgeInboxStore(
  database: SqlDatabase,
  scope: "standalone" | "workspace" = "standalone",
  chunks?: ReturnType<typeof createWorkspaceBridgeChunks>,
) {
  const metaTable = scope === "workspace" ? "bridge_inbox_meta" : "meta";
  const inboxTable = scope === "workspace" ? "bridge_inbox" : "inbox";
  const cursorRow = database.prepare(`SELECT value FROM ${metaTable} WHERE key='ack'`);
  const updateCursor = database.prepare(`UPDATE ${metaTable} SET value=? WHERE key='ack'`);
  const sourceRow = database.prepare(`SELECT value FROM ${metaTable} WHERE key='inbox-source'`);
  const pinSource = database.prepare(`INSERT INTO ${metaTable} (key,value) VALUES ('inbox-source',?)`);
  const existing = database.prepare(`SELECT route,generation,payload,projection FROM ${inboxTable} WHERE seq=?`);
  const insert = database.prepare(
    `INSERT INTO ${inboxTable} (seq,route,generation,payload,projection) VALUES (?,?,?,?,?)`,
  );
  const page = database.prepare(
    `SELECT seq,route,generation,payload,projection FROM ${inboxTable} WHERE seq>? ORDER BY seq LIMIT 256`,
  );
  const pendingPage = database.prepare(
    `SELECT seq, ${INTERACTION_ID} AS id, projection = '' AS chunked,
      CASE WHEN projection <> '' THEN json_extract(payload,'$.params') END AS params
    FROM ${inboxTable} WHERE route=? AND seq>? AND seq<=? AND ${ROUTE_PROJECTION}
      AND ${INTERACTION_REQUEST} AND ${INTERACTION_ID} IN (SELECT value FROM json_each(?))
    ORDER BY seq LIMIT 256`,
  );
  const historyQuery = `SELECT ${HISTORY_IDENTITY_COLUMNS}
    FROM ${inboxTable} WHERE route=? AND seq>? AND seq<=? AND ${ROUTE_PROJECTION} AND ${HISTORY_IDENTITIES}`;
  const historyPage = database.prepare(`${historyQuery} ORDER BY seq LIMIT 256`);
  let selectedHistoryPage: ReturnType<typeof prepareSelectedHistory> | undefined;
  const cursor = () => Number(cursorRow.get()!.value);
  // An empty projection marks a workspace row whose contents live in chunks.
  const storedPayload = (row: SqlRow, seq: number) =>
    chunks && row.projection === "" ? chunks.read(seq) : String(row.payload);
  // Keep the two JSON columns and row metadata below the legacy 2 MB DO limit.
  const inlineLimit = 1800 * 1024;
  const encoder = new TextEncoder();
  const fitsInline = (payload: string, projection: string) =>
    (payload.length + projection.length) * 3 <= inlineLimit ||
    (payload.length + projection.length <= inlineLimit &&
      encoder.encode(payload).byteLength + encoder.encode(projection).byteLength <= inlineLimit);

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
              storedPayload(previous, row.seq) !== encoded
            )
              throw new BridgeInboxRefusal("Conflicting replay");
            continue;
          }
          if (row.seq !== position + 1) throw new BridgeInboxRefusal("Outbox sequence gap");
          const projection =
            chunks && !fitsInline(encoded, "") ? "" : JSON.stringify(projectionFor(row.payload, row.route));
          if (chunks && (projection === "" || !fitsInline(encoded, projection))) {
            chunks.write(row.seq, encoded);
            insert.run(row.seq, row.route, row.generation, indexedPayload(row.payload), "");
          } else {
            insert.run(row.seq, row.route, row.generation, encoded, projection);
          }
          position = row.seq;
          inserted.push(row);
        }
        if (position !== previousCursor) updateCursor.run(String(position));
        return { cursor: position, inserted };
      });
    },
    read(after = 0): OutboxEvent[] {
      const rows: (OutboxEvent & { projection: unknown })[] = [];
      let bytes = 0;
      for (const row of page.iterate(after)) {
        const seq = Number(row.seq), route = String(row.route), generation = String(row.generation);
        const projection = String(row.projection);
        const chunked = chunks !== undefined && projection === "";
        if (chunked && rows.length) break;
        const encoded = storedPayload(row, seq);
        // Bound each replay page without another UTF-8 copy. A single large
        // event still advances the cursor and always occupies its own page.
        const rowBytes = (encoded.length + projection.length + route.length + generation.length) * 3 + 64;
        if (rows.length && bytes + rowBytes > BRIDGE_OUTBOX_PAGE_BYTES) break;
        const payload = JSON.parse(encoded);
        rows.push({
          seq, route, generation, payload,
          projection: chunked ? projectionFor(payload, route) : JSON.parse(projection),
        });
        bytes += rowBytes;
        if (chunked || bytes >= BRIDGE_OUTBOX_PAGE_BYTES) break;
      }
      return rows;
    },
    readIdentities(route: string, after: number, through: number, selection?: BridgeHistorySelection): BridgeInboxIdentity[] {
      return selection
        ? (selectedHistoryPage ??= prepareSelectedHistory(database, inboxTable))(route, after, through, selection)
        : historyPage.all(route, after, through).map(historyIdentity);
    },
    readPendingInteractions(route: string, after: number, through: number, ids: readonly string[]): BridgeInboxPendingInteraction[] {
      if (!ids.length) return [];
      const rows: BridgeInboxPendingInteraction[] = [];
      let bytes = 0;
      for (const row of pendingPage.iterate(route, after, through, JSON.stringify(ids))) {
        const seq = Number(row.seq), id = String(row.id);
        const chunked = chunks !== undefined && row.chunked === 1;
        if (chunked && rows.length) break;
        const encoded = chunked ? chunks.read(seq) : String(row.params);
        const rowBytes = (id.length + encoded.length) * 3 + 64;
        if (rows.length && bytes + rowBytes > BRIDGE_OUTBOX_PAGE_BYTES) break;
        const body = JSON.parse(encoded);
        rows.push({ seq, id, params: chunked ? body.params : body });
        bytes += rowBytes;
        if (chunked || bytes >= BRIDGE_OUTBOX_PAGE_BYTES) break;
      }
      return rows;
    },
  };
}

/** The WorkspaceHost may rebind its inbox after it verifies a new sandbox receipt. */
export function createWorkspaceBridgeInboxStore(database: SqlDatabase) {
  const chunks = createWorkspaceBridgeChunks(database);
  const inbox = createBridgeInboxStore(database, "workspace", chunks);
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
    readIdentities: inbox.readIdentities,
    readAcknowledgedIdentities(route: string, after: number, through: number, outboxId: string, selection?: BridgeHistorySelection) {
      if (meta.get("inbox-source")?.value !== outboxId || inbox.cursor() < through)
        throw new BridgeInboxRefusal("Bridge history identity prefix is missing from the inbox");
      return inbox.readIdentities(route, after, through, selection);
    },
    readPendingInteractions: inbox.readPendingInteractions,
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
            chunks.archive(previous, checkpoint);
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
