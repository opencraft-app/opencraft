import { randomUUID } from "node:crypto";
import {
  openManagedDatabase,
  createSchemaValidator,
} from "@opencraft/sqlite-node";
import {
  conversationRef,
  type ConversationRef,
} from "@opencraft/appserver-protocol/collaboration";

const schema = `CREATE TABLE switchboard (
 id TEXT PRIMARY KEY, bot_endpoint_id TEXT NOT NULL, source_key TEXT NOT NULL,
 conversation_ref TEXT NOT NULL, UNIQUE(bot_endpoint_id,source_key)
) STRICT;`;
const v2 = `
CREATE TABLE im_channels(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, config TEXT NOT NULL, revision INTEGER NOT NULL, route TEXT, draft TEXT, enabled INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE im_route_versions(channel_id TEXT NOT NULL, revision INTEGER NOT NULL, source TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(channel_id,revision)) STRICT;
CREATE TABLE im_messages(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, route_revision INTEGER NOT NULL, decision TEXT, conversation_ref TEXT, request_id TEXT, reply_address TEXT, reply_text TEXT, state TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE INDEX im_messages_channel ON im_messages(channel_id,created_at);
CREATE TABLE im_identity_challenges(hash TEXT PRIMARY KEY, channel_id TEXT NOT NULL, actor_id TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE im_sender_links(channel_id TEXT NOT NULL, sender_id TEXT NOT NULL, actor_id TEXT NOT NULL, PRIMARY KEY(channel_id,sender_id)) STRICT;
`;
const v3 = `
ALTER TABLE im_messages ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'final';
ALTER TABLE im_messages ADD COLUMN reply_ref TEXT;
ALTER TABLE im_messages ADD COLUMN reply_expires_at INTEGER;
CREATE UNIQUE INDEX im_messages_reply_ref ON im_messages(reply_ref) WHERE reply_ref IS NOT NULL;
`;
export const switchboardMigrations = [
  { version: 1, name: "im-switchboard", sql: schema },
  { version: 2, name: "im-programmable-routing", sql: v2 },
  { version: 3, name: "im-explicit-replies", sql: v3 },
];

export interface ChannelConfig {
  id: string;
  provider: "wecom" | "slack";
  ownerId: string;
  name: string;
  groupScope: "chat" | "sender";
  botId?: string;
  workspaceId?: string;
  botUserId?: string;
}
export interface Channel extends ChannelConfig {
  revision: number;
  route: string | null;
  draft: string | null;
  enabled: boolean;
}
export interface StoredMessage {
  id: string;
  channel_id: string;
  fingerprint: string;
  actor_id: string;
  source: string;
  text: string;
  route_revision: number;
  decision: string | null;
  conversation_ref: string | null;
  request_id: string | null;
  reply_address: string | null;
  reply_text: string | null;
  reply_mode: "final" | "tool";
  reply_ref: string | null;
  reply_expires_at: number | null;
  state: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** The IM plugin owns only current bindings; native conversations retain their history. */
export class SwitchboardStore {
  private readonly managed;
  constructor(path: string) {
    this.managed = openManagedDatabase({
      path,
      legacyPolicy: "reject",
      migrations: switchboardMigrations,
      validateSchema: createSchemaValidator(schema + v2 + v3),
    });
  }
  get outcome() {
    return this.managed.outcome;
  }
  get(endpointId: string, sourceKey: string): ConversationRef | null {
    const row = this.managed.database
      .prepare(
        "SELECT conversation_ref FROM switchboard WHERE bot_endpoint_id=? AND source_key=?",
      )
      .get(endpointId, sourceKey);
    return row
      ? conversationRef(JSON.parse(String(row.conversation_ref)))
      : null;
  }
  bind(endpointId: string, sourceKey: string, ref: ConversationRef): void {
    this.managed.database
      .prepare(
        `INSERT INTO switchboard VALUES(?,?,?,?) ON CONFLICT(bot_endpoint_id,source_key) DO UPDATE SET conversation_ref=excluded.conversation_ref`,
      )
      .run(
        randomUUID(),
        endpointId,
        sourceKey,
        JSON.stringify(conversationRef(ref)),
      );
  }
  channels(ownerId?: string): Channel[] {
    const rows =
      ownerId === undefined
        ? this.managed.database
            .prepare("SELECT * FROM im_channels WHERE deleted=0")
            .all()
        : this.managed.database
            .prepare("SELECT * FROM im_channels WHERE deleted=0 AND owner_id=?")
            .all(ownerId);
    return rows.map((r) => ({
      ...JSON.parse(String(r.config)),
      revision: Number(r.revision),
      route: r.route === null ? null : String(r.route),
      draft: r.draft === null ? null : String(r.draft),
      enabled: r.enabled === 1,
    }));
  }
  hasChannel(id: string): boolean {
    return !!this.managed.database
      .prepare("SELECT 1 FROM im_channels WHERE id=?")
      .get(id);
  }
  channel(id: string): Channel | null {
    return this.channels().find((c) => c.id === id) ?? null;
  }
  saveChannel(
    config: ChannelConfig,
    enabled: boolean,
    expected: number | null,
  ): Channel {
    const db = this.managed.database;
    const {
      id,
      provider,
      ownerId,
      name,
      groupScope,
      botId,
      workspaceId,
      botUserId,
    } = config;
    const serialized = JSON.stringify({
      id,
      provider,
      ownerId,
      name,
      groupScope,
      botId,
      workspaceId,
      botUserId,
    });
    if (expected === null)
      db.prepare(
        "INSERT INTO im_channels(id,owner_id,config,revision,enabled) VALUES(?,?,?,1,?)",
      ).run(config.id, config.ownerId, serialized, enabled ? 1 : 0);
    else if (
      Number(
        db
          .prepare(
            "UPDATE im_channels SET config=?,enabled=?,revision=revision+1 WHERE id=? AND owner_id=? AND revision=? AND deleted=0",
          )
          .run(serialized, enabled ? 1 : 0, config.id, config.ownerId, expected)
          .changes,
      ) !== 1
    )
      throw new Error("revision_conflict");
    return this.channel(config.id)!;
  }
  route(
    id: string,
    expected: number,
    source: string | null,
    publish: boolean,
  ): Channel {
    const db = this.managed.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const c = this.channel(id);
      if (!c || c.revision !== expected) throw new Error("revision_conflict");
      if (publish) {
        db.prepare("INSERT INTO im_route_versions VALUES(?,?,?,?)").run(
          id,
          c.revision,
          c.route,
          Date.now(),
        );
        db.prepare(
          "UPDATE im_channels SET route=?,draft=?,revision=revision+1 WHERE id=?",
        ).run(source, source, id);
      } else
        db.prepare(
          "UPDATE im_channels SET draft=?,revision=revision+1 WHERE id=?",
        ).run(source, id);
      db.exec("COMMIT");
      return this.channel(id)!;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  versions(id: string) {
    return this.managed.database
      .prepare(
        "SELECT revision,source,created_at FROM im_route_versions WHERE channel_id=? ORDER BY revision DESC LIMIT 20",
      )
      .all(id);
  }
  removeChannel(id: string) {
    const db = this.managed.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE im_channels SET deleted=1,enabled=0 WHERE id=?").run(
        id,
      );
      db.prepare("DELETE FROM switchboard WHERE bot_endpoint_id=?").run(id);
      db.prepare("DELETE FROM im_sender_links WHERE channel_id=?").run(id);
      db.prepare("DELETE FROM im_identity_challenges WHERE channel_id=?").run(
        id,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  senderLinks(id: string): Record<string, string> {
    return Object.fromEntries(
      this.managed.database
        .prepare(
          "SELECT sender_id,actor_id FROM im_sender_links WHERE channel_id=?",
        )
        .all(id)
        .map((r) => [String(r.sender_id), String(r.actor_id)]),
    );
  }
  linkSender(id: string, sender: string, actor: string) {
    const previous = this.senderLinks(id)[sender];
    if (previous && previous !== actor) throw new Error("identity_conflict");
    this.managed.database
      .prepare(
        "INSERT INTO im_sender_links VALUES(?,?,?) ON CONFLICT(channel_id,sender_id) DO NOTHING",
      )
      .run(id, sender, actor);
  }
  unlinkSender(id: string, sender: string) {
    this.managed.database
      .prepare("DELETE FROM im_sender_links WHERE channel_id=? AND sender_id=?")
      .run(id, sender);
  }
  challenge(hash: string, id: string, actor: string) {
    const db = this.managed.database;
    db.prepare("UPDATE im_messages SET state='reply_failed',error='reply_expired',updated_at=? WHERE reply_mode='tool' AND state IN ('accepted','submitted') AND reply_expires_at<=?").run(Date.now(), Date.now());
    db.prepare(
      "DELETE FROM im_identity_challenges WHERE expires_at<? OR (channel_id=? AND actor_id=?)",
    ).run(Date.now(), id, actor);
    db.prepare("INSERT INTO im_identity_challenges VALUES(?,?,?,?)").run(
      hash,
      id,
      actor,
      Date.now() + 300_000,
    );
  }
  consumeChallenge(
    hash: string,
    id: string,
    sender: string,
    validate: (actor: string) => void = () => {},
  ): string | null {
    const db = this.managed.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = db
        .prepare(
          "SELECT actor_id FROM im_identity_challenges WHERE hash=? AND channel_id=? AND expires_at>?",
        )
        .get(hash, id, Date.now());
      if (!r) {
        db.exec("COMMIT");
        return null;
      }
      validate(String(r.actor_id));
      this.linkSender(id, sender, String(r.actor_id));
      db.prepare("DELETE FROM im_identity_challenges WHERE hash=?").run(hash);
      db.exec("COMMIT");
      return String(r.actor_id);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  message(id: string): StoredMessage | null {
    return (
      (this.managed.database
        .prepare("SELECT * FROM im_messages WHERE id=?")
        .get(id) as unknown as StoredMessage) ?? null
    );
  }
  accept(
    m: Pick<
      StoredMessage,
      | "id"
      | "channel_id"
      | "fingerprint"
      | "actor_id"
      | "source"
      | "text"
      | "route_revision"
      | "decision"
      | "reply_address"
    >,
  ) {
    this.prune();
    const pending = this.managed.database
      .prepare(
        "SELECT count(*) AS n FROM im_messages WHERE state IN ('routing','accepted','submitted','reply_pending','reply_attempting')",
      )
      .get();
    if (Number(pending?.n) >= 1024) throw new Error("busy");
    this.managed.database
      .prepare(
        "INSERT INTO im_messages(id,channel_id,fingerprint,actor_id,source,text,route_revision,decision,reply_address,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        m.id,
        m.channel_id,
        m.fingerprint,
        m.actor_id,
        m.source,
        m.text,
        m.route_revision,
        m.decision,
        m.reply_address,
        "routing",
        Date.now(),
        Date.now(),
      );
  }
  patch(
    id: string,
    value: Partial<
      Pick<
        StoredMessage,
        "conversation_ref" | "request_id" | "reply_text" | "state" | "error" | "reply_mode" | "reply_ref" | "reply_expires_at"
      >
    >,
  ) {
    const allowed = [
      "conversation_ref",
      "request_id",
      "reply_text",
      "state",
      "error",
      "reply_mode",
      "reply_ref",
      "reply_expires_at",
    ];
    const entries = Object.entries(value).filter(([key]) =>
      allowed.includes(key),
    );
    if (entries.length)
      this.managed.database
        .prepare(
          `UPDATE im_messages SET ${entries.map(([k]) => k + "=?").join(",")},updated_at=? WHERE id=?`,
        )
        .run(...entries.map(([, v]) => v ?? null), Date.now(), id);
  }
  submitted(id: string, requestId: string) {
    // Admission may race the first tool invocation; never overwrite its effect state.
    this.managed.database.prepare("UPDATE im_messages SET request_id=?,state=CASE WHEN state='accepted' THEN 'submitted' ELSE state END,updated_at=? WHERE id=?")
      .run(requestId, Date.now(), id);
  }
  replyReference(ref: string): StoredMessage | null {
    return this.managed.database.prepare("SELECT * FROM im_messages WHERE reply_ref=?").get(ref) as unknown as StoredMessage ?? null;
  }
  toolMessages(reference: string): StoredMessage[] {
    this.prune();
    return this.managed.database.prepare("SELECT * FROM im_messages WHERE conversation_ref=? AND reply_mode='tool' AND (state IN ('delivered','reply_unknown') OR (reply_expires_at>? AND state IN ('accepted','submitted','reply_attempting'))) ORDER BY created_at DESC LIMIT 1024")
      .all(reference, Date.now()) as unknown as StoredMessage[];
  }
  claimReply(id: string, text: string): boolean {
    return this.managed.database.prepare("UPDATE im_messages SET state='reply_attempting',reply_text=?,updated_at=? WHERE id=? AND reply_mode='tool' AND state IN ('accepted','submitted') AND reply_expires_at>?")
      .run(text, Date.now(), id, Date.now()).changes === 1;
  }
  /** Filter the authority boundary before the retention bound, never scan other senders. */
  readableMessages(reference: string, channelId: string, actorId: string): StoredMessage[] {
    return this.managed.database.prepare("SELECT * FROM im_messages WHERE conversation_ref=? AND channel_id=? AND actor_id=? AND reply_mode='tool' AND created_at>=? AND state IN ('accepted','submitted','reply_pending','reply_attempting','delivered','reply_failed','reply_unknown') ORDER BY created_at DESC,id DESC LIMIT 10000")
      .all(reference, channelId, actorId, Date.now() - 7 * 86_400_000) as unknown as StoredMessage[];
  }
  readableAnchor(reference: string): StoredMessage[] {
    return this.managed.database.prepare("SELECT * FROM im_messages WHERE conversation_ref=? AND reply_mode='tool' AND reply_ref IS NOT NULL AND created_at>=? AND state IN ('accepted','submitted','reply_pending','reply_attempting','delivered','reply_failed','reply_unknown') ORDER BY created_at DESC,id DESC LIMIT 1024")
      .all(reference, Date.now() - 7 * 86_400_000) as unknown as StoredMessage[];
  }
  messages(id: string, limit = 100): StoredMessage[] {
    return this.managed.database
      .prepare(
        "SELECT * FROM im_messages WHERE channel_id=? ORDER BY created_at DESC LIMIT ?",
      )
      .all(id, Math.min(limit, 500)) as unknown as StoredMessage[];
  }
  recoverable(channelId: string): StoredMessage[] {
    return this.managed.database
      .prepare(
        "SELECT * FROM im_messages WHERE channel_id=? AND state IN ('accepted','submitted','reply_pending') ORDER BY created_at LIMIT 1024",
      )
      .all(channelId) as unknown as StoredMessage[];
  }
  interruptUncertain() {
    this.managed.database
      .prepare(
        "UPDATE im_messages SET state='unknown',error='admission_interrupted' WHERE state='routing'",
      )
      .run();
    this.managed.database
      .prepare(
        "UPDATE im_messages SET state='reply_unknown',error='delivery_unconfirmed' WHERE state='reply_attempting'",
      )
      .run();
  }
  prune() {
    const db = this.managed.database;
    db.prepare("UPDATE im_messages SET state='reply_failed',error='reply_expired',updated_at=? WHERE reply_mode='tool' AND state IN ('accepted','submitted') AND reply_expires_at<=?").run(Date.now(), Date.now());
    db.prepare(
      "DELETE FROM im_messages WHERE state IN ('delivered','ignored','failed','reply_failed','reply_unknown','unknown') AND created_at<?",
    ).run(Date.now() - 7 * 86_400_000);
    db.prepare(
      "DELETE FROM im_messages WHERE id IN (SELECT id FROM im_messages WHERE state IN ('delivered','ignored','failed','reply_failed','reply_unknown','unknown') ORDER BY created_at DESC LIMIT -1 OFFSET 10000)",
    ).run();
  }
  close() {
    this.managed.database.close();
  }
}
