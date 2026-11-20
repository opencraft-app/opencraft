import type { DatabaseSync } from "node:sqlite";
import type {
  ChannelMention,
  ChannelMentionInput,
} from "@opencraft/appserver-protocol";
import type { Collaboration } from "./collaboration.js";
/** Mention identity is explicit. Plain @text is never an identity lookup or a wake instruction. */
export function channelMentionInputs(value: unknown): ChannelMentionInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32)
    throw Error("invalid_channel_mentions");
  const result = value
    .map((v) => {
      if (
        !v ||
        typeof v !== "object" ||
        Object.keys(v).some((k) => !["actorId", "start", "end"].includes(k)) ||
        typeof v.actorId !== "string" ||
        !v.actorId ||
        v.actorId.length > 256 ||
        !Number.isSafeInteger(v.start) ||
        !Number.isSafeInteger(v.end) ||
        v.start < 0 ||
        v.end <= v.start
      )
        throw Error("invalid_channel_mentions");
      return {
        actorId: v.actorId as string,
        start: v.start as number,
        end: v.end as number,
      };
    })
    .sort((a, b) => a.start - b.start);
  if (result.some((v, i) => i > 0 && v.start < result[i - 1]!.end))
    throw Error("invalid_channel_mentions");
  return result;
}
export function admitChannelMentions(
  service: Collaboration,
  channelId: string,
  body: string,
  inputs: ChannelMentionInput[],
): ChannelMention[] {
  return inputs.map((m) => {
    const actor = service.actors.get(m.actorId);
    if (!actor?.enabled || !service.channels.isMember(channelId, m.actorId))
      throw Error("channel_mention_unavailable");
    if (
      m.end > body.length ||
      body.slice(m.start, m.end) !== "@" + actor.displayName
    )
      throw Error("channel_mention_unavailable");
    return { ...m, displayName: actor.displayName, actorKind: actor.kind };
  });
}
export function persistChannelMentions(
  db: DatabaseSync,
  messageId: string,
  mentions: ChannelMention[],
) {
  const write = db.prepare(
    "INSERT INTO actor_channel_mentions(message_id,actor_id,start,end,display_name,actor_kind) VALUES(?,?,?,?,?,?)",
  );
  for (const m of mentions)
    write.run(messageId, m.actorId, m.start, m.end, m.displayName, m.actorKind);
}
export function readChannelMentions(
  db: DatabaseSync,
  messageId: string,
  viewer?: string,
): ChannelMention[] {
  const unread=viewer===undefined?false:!!db.prepare(`SELECT 1 FROM actor_channel_mentions n
    JOIN actor_messages m ON m.id=n.message_id
    JOIN actor_channel_members cm ON cm.channel_id=m.channel_id AND cm.actor_id=n.actor_id
    JOIN actor_channel_reads r ON r.channel_id=cm.channel_id AND r.actor_id=cm.actor_id AND r.epoch=cm.epoch
    WHERE n.message_id=? AND n.actor_id=? AND m.author_id<>? AND m.seq>r.joined_seq
    AND NOT EXISTS(SELECT 1 FROM actor_channel_mention_reads a WHERE a.message_id=n.message_id AND a.actor_id=n.actor_id) LIMIT 1`).get(messageId,viewer,viewer);
  return db
    .prepare(
      "SELECT actor_id,start,end,display_name,actor_kind FROM actor_channel_mentions WHERE message_id=? ORDER BY start LIMIT 32",
    )
    .all(messageId)
    .map((m) => ({
      actorId: String(m.actor_id),
      start: Number(m.start),
      end: Number(m.end),
      displayName: String(m.display_name),
      actorKind: m.actor_kind as "human" | "session",
      ...(viewer === undefined ? {} : { isSelf: m.actor_id === viewer, ...(m.actor_id === viewer ? {isUnread:unread} : {}) }),
    }));
}
