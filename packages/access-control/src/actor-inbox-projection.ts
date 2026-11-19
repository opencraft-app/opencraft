import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sqliteTransaction } from "@opencraft/sqlite-node";
import type { ActorInboxItem, ActorInboxPage } from "@opencraft/appserver-protocol/collaboration";

export interface InboxSyncRequest {
  actorId: string;
  generation: number;
  cursor?: string;
  limit: number;
}
interface Cursor {
  epoch: string;
  actorId: string;
  generation: number;
  revision: number;
}
function invalidCursor(): never {
  throw Object.assign(new Error("invalid_inbox_cursor"), { code: "invalid_inbox_cursor" });
}
function decode(value: string): Cursor {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return invalidCursor();
  let data: Cursor;
  try {
    data = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return invalidCursor();
  }
  if (
    !data ||
    typeof data.epoch !== "string" ||
    typeof data.actorId !== "string" ||
    !Number.isSafeInteger(data.generation) ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0
  )
    return invalidCursor();
  return data;
}
/** Runs only in a storage Worker. Communication facts remain the source of truth.
 * Reconciliation and page selection share a transaction, including read-only polls.
 * Sparse revisions describe current rows, not delivery events or read-through cursors. */
export function syncActorInbox(db: DatabaseSync, request: InboxSyncRequest): ActorInboxPage {
  const { actorId, generation, limit } = request;
  if (!actorId || !Number.isSafeInteger(generation) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid_inbox_request");
  const supplied = request.cursor === undefined ? null : decode(request.cursor);
  if (supplied && (supplied.actorId !== actorId || supplied.generation !== generation)) return invalidCursor();
  return sqliteTransaction(db, () => {
    let clock = db.prepare("SELECT epoch,revision FROM actor_inbox_clock WHERE id=1").get();
    if (!clock) {
      db.prepare("INSERT INTO actor_inbox_clock VALUES(1,?,0)").run(randomUUID());
      clock = db.prepare("SELECT epoch,revision FROM actor_inbox_clock WHERE id=1").get()!;
    }
    let revision = Number(clock.revision);
    const reset = !supplied || supplied.epoch !== clock.epoch;
    if (!reset && supplied!.revision > revision) return invalidCursor();
    const after = reset ? 0 : supplied!.revision;
    // Both participants see the same channel history; only the receiver owns unread.
    const facts = db
      .prepare(
        `SELECT ch.id AS channel_id,ch.owner_id,ch.peer_id,m.id,m.seq,m.author_id,m.content,m.created_at,CAST(m.seq AS TEXT) AS message_seq,
      (SELECT COUNT(*) FROM actor_deliveries d JOIN actor_messages u ON u.id=d.message_id
       WHERE d.receiver_id=? AND d.state='received' AND u.channel_id=ch.id) AS unread
      FROM actor_channels ch LEFT JOIN actor_messages m ON m.id=(SELECT id FROM actor_messages WHERE channel_id=ch.id AND target_kind='actor' ORDER BY seq DESC LIMIT 1)
      WHERE ch.peer_id IS NOT NULL AND (ch.owner_id=? OR ch.peer_id=?) ORDER BY ch.id`,
      )
      .all(actorId, actorId, actorId);
    const previous = new Map(
      db
        .prepare("SELECT channel_id,payload FROM actor_inbox_rows WHERE actor_id=?")
        .all(actorId)
        .map((row) => [String(row.channel_id), row.payload]),
    );
    const write = db.prepare(`INSERT INTO actor_inbox_rows(actor_id,channel_id,revision,payload) VALUES(?,?,?,?)
      ON CONFLICT(actor_id,channel_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload`);
    const update = (channelId: string, payload: string | null) => {
      if (revision >= Number.MAX_SAFE_INTEGER) throw new Error("inbox_revision_exhausted");
      write.run(actorId, channelId, ++revision, payload);
    };
    for (const fact of facts) {
      const channelId = String(fact.channel_id);
      const item: ActorInboxItem = {
        channelId,
        kind: "direct",
        peerActorId: String(fact.owner_id === actorId ? fact.peer_id : fact.owner_id),
        latestMessage:
          fact.id === null
            ? null
            : {
                id: String(fact.id),
                sequence: String(fact.message_seq),
                authorId: String(fact.author_id),
                text: String(fact.content),
                at: Number(fact.created_at),
              },
        unreadCount: Number(fact.unread),
      };
      const payload = JSON.stringify(item);
      if (previous.get(channelId) !== payload) update(channelId, payload);
      previous.delete(channelId);
    }
    const groups = db
      .prepare(
        `SELECT ch.id,ch.title,m.id AS message_id,CAST(m.seq AS TEXT) AS message_seq,m.author_id,m.content,m.created_at,
      (SELECT COUNT(*) FROM actor_messages u WHERE u.channel_id=ch.id AND u.target_kind='channel'
       AND u.seq>MAX(COALESCE(r.joined_seq,0),COALESCE(r.read_seq,0)) AND u.author_id<>?) AS unread,
      (SELECT COUNT(*) FROM (SELECT DISTINCT u.id,u.seq FROM actor_channel_mentions n JOIN actor_messages u ON u.id=n.message_id
       WHERE n.actor_id=cm.actor_id AND u.channel_id=ch.id AND u.target_kind='channel'
       AND u.seq>COALESCE(r.joined_seq,0) AND u.author_id<>cm.actor_id
       AND NOT EXISTS(SELECT 1 FROM actor_channel_mention_reads a WHERE a.message_id=u.id AND a.actor_id=cm.actor_id))) AS mentions,
      (SELECT MIN(seq) FROM (SELECT DISTINCT u.id,u.seq FROM actor_channel_mentions n JOIN actor_messages u ON u.id=n.message_id
       WHERE n.actor_id=cm.actor_id AND u.channel_id=ch.id AND u.target_kind='channel'
       AND u.seq>COALESCE(r.joined_seq,0) AND u.author_id<>cm.actor_id
       AND NOT EXISTS(SELECT 1 FROM actor_channel_mention_reads a WHERE a.message_id=u.id AND a.actor_id=cm.actor_id))) AS first_mention
      FROM actor_channels ch JOIN actor_channel_members cm ON cm.channel_id=ch.id AND cm.actor_id=?
      LEFT JOIN actor_channel_reads r ON r.channel_id=ch.id AND r.actor_id=cm.actor_id AND r.epoch=cm.epoch
      LEFT JOIN actor_messages m ON m.id=(SELECT id FROM actor_messages WHERE channel_id=ch.id AND target_kind='channel' ORDER BY seq DESC LIMIT 1)
      WHERE ch.peer_id IS NULL AND NOT EXISTS(SELECT 1 FROM actor_channel_list_states v WHERE v.channel_id=ch.id AND v.actor_id=cm.actor_id AND v.hidden=1) ORDER BY ch.id`,
      )
      .all(actorId, actorId);
    for (const row of groups) {
      const channelId = String(row.id);
      const item: ActorInboxItem = {
        channelId,
        kind: "group",
        title: String(row.title),
        unreadCount: Number(row.unread),
        mentionUnreadCount: Number(row.mentions),
        ...(row.first_mention === null ? {} : { firstUnreadMentionSequence: Number(row.first_mention) }),
        latestMessage:
          row.message_id === null
            ? null
            : {
                id: String(row.message_id),
                sequence: String(row.message_seq),
                authorId: String(row.author_id),
                text: String(row.content),
                at: Number(row.created_at),
              },
      };
      const payload = JSON.stringify(item);
      if (previous.get(channelId) !== payload) update(channelId, payload);
      previous.delete(channelId);
    }
    for (const [channelId, payload] of previous) if (payload !== null) update(channelId, null);
    if (revision !== clock.revision) db.prepare("UPDATE actor_inbox_clock SET revision=? WHERE id=1").run(revision);
    const rows = db
      .prepare(
        "SELECT channel_id,CAST(revision AS TEXT) AS revision,payload FROM actor_inbox_rows WHERE actor_id=? AND revision>? ORDER BY actor_inbox_rows.revision LIMIT ?",
      )
      .all(actorId, after, limit + 1);
    const hasMore = rows.length > limit,
      page = rows.slice(0, limit);
    const next = page.length ? Number(page[page.length - 1].revision) : after;
    const cursor: Cursor = { epoch: String(clock.epoch), actorId, generation, revision: next };
    return {
      actorId,
      reset,
      hasMore,
      cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
      changes: page.map((row) => ({
        channelId: String(row.channel_id),
        revision: String(row.revision),
        item: row.payload === null ? null : (JSON.parse(String(row.payload)) as ActorInboxItem),
      })),
    };
  });
}
