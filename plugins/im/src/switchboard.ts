import { WorkerOwner, ownerEntry, type OwnerCalls } from "@opencraft/worker-owner";
import type { ConversationRef } from "@opencraft/appserver-protocol/collaboration";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import type { Channel, ChannelConfig, ReplyAnchor, StoredMessage } from "./store.js";
import type { SwitchboardChange, SwitchboardConfig, SwitchboardOwner } from "./switchboard-owner.js";

export type SwitchboardPort = OwnerCalls<SwitchboardOwner>;
export interface SwitchboardSnapshot {
  readonly outcome: DatabaseOutcome;
  readonly config: SwitchboardConfig;
  readonly anchors: ReplyAnchor[];
}

const RETENTION = 7 * 86_400_000;
const READABLE = new Set([
  "accepted",
  "submitted",
  "reply_pending",
  "reply_attempting",
  "delivered",
  "reply_failed",
  "reply_unknown",
]);
const newestFirst = (a: ReplyAnchor, b: ReplyAnchor) =>
  b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * The IM switchboard for a network thread. A Worker owns the SQLite database.
 * Channel configuration, sender links and explicit-reply anchors are read
 * from memory because routing checks them synchronously on every message;
 * each write resolves after the owner committed it and returned the changed
 * projection. Message bodies and conversation bindings are read through the
 * owner asynchronously.
 */
export class Switchboard {
  private config: SwitchboardConfig;
  private readonly anchors = new Map<string, ReplyAnchor>();
  private readonly anchorsByReply = new Map<string, ReplyAnchor>();
  readonly outcome: DatabaseOutcome;

  constructor(
    private readonly port: SwitchboardPort,
    snapshot: SwitchboardSnapshot,
    private readonly release: () => Promise<void>,
  ) {
    this.outcome = snapshot.outcome;
    this.config = snapshot.config;
    this.replaceAnchors(snapshot.anchors);
  }

  /** Opens the switchboard database in its owner Worker. */
  static async open(path: string): Promise<Switchboard> {
    const { owner, ready } = await WorkerOwner.open<SwitchboardOwner, SwitchboardSnapshot>(
      ownerEntry(import.meta.url, "switchboard"),
      { name: "IM storage", workerData: { path } },
    );
    return new Switchboard(owner.call, ready, () => owner.close());
  }

  close(): Promise<void> {
    return this.release();
  }

  /** Reloads the projection from the owner, after the database changed outside this switchboard. */
  async refresh(): Promise<void> {
    const snapshot = await this.port.snapshot();
    this.config = snapshot.config;
    this.replaceAnchors(snapshot.anchors);
  }

  // Configuration, from memory.
  channels(ownerId?: string): Channel[] {
    return structuredClone(
      ownerId === undefined ? this.config.channels : this.config.channels.filter((c) => c.ownerId === ownerId),
    );
  }
  hasChannel(id: string): boolean {
    return this.config.channelIds.includes(id);
  }
  channel(id: string): Channel | null {
    const channel = this.config.channels.find((c) => c.id === id);
    return channel ? structuredClone(channel) : null;
  }
  senderLinks(id: string): Record<string, string> {
    return { ...this.config.links[id] };
  }
  versions(id: string): unknown[] {
    return structuredClone(this.config.versions[id] ?? []);
  }

  // Explicit-reply anchors, from memory; retention applies at read time.
  toolMessages(reference: string): ReplyAnchor[] {
    const now = Date.now();
    return this.current(reference)
      .filter(
        (m) =>
          ["delivered", "reply_unknown"].includes(m.state) ||
          (m.reply_expires_at !== null &&
            m.reply_expires_at > now &&
            ["accepted", "submitted", "reply_attempting"].includes(m.state)),
      )
      .slice(0, 1024);
  }
  readableAnchor(reference: string): ReplyAnchor[] {
    return this.current(reference)
      .filter((m) => READABLE.has(m.state))
      .slice(0, 1024);
  }
  anchorByReplyRef(ref: string): ReplyAnchor | null {
    const anchor = this.anchorsByReply.get(ref);
    return anchor ? { ...anchor } : null;
  }

  // Messages, through the owner.
  get(endpointId: string, sourceKey: string): Promise<ConversationRef | null> {
    return this.port.get(endpointId, sourceKey);
  }
  message(id: string): Promise<StoredMessage | null> {
    return this.port.message(id);
  }
  replyReference(ref: string): Promise<StoredMessage | null> {
    return this.port.replyReference(ref);
  }
  readableMessages(reference: string, channelId: string, actorId: string): Promise<StoredMessage[]> {
    return this.port.readableMessages(reference, channelId, actorId);
  }
  messages(id: string, limit?: number): Promise<StoredMessage[]> {
    return this.port.messages(id, limit);
  }
  recoverable(channelId: string): Promise<StoredMessage[]> {
    return this.port.recoverable(channelId);
  }
  bind(endpointId: string, sourceKey: string, ref: ConversationRef) {
    return this.apply(this.port.bind(endpointId, sourceKey, ref));
  }
  accept(m: Parameters<SwitchboardPort["accept"]>[0]) {
    return this.apply(this.port.accept(m));
  }
  patch(id: string, value: Parameters<SwitchboardPort["patch"]>[1]) {
    return this.apply(this.port.patch(id, value));
  }
  submitted(id: string, requestId: string) {
    return this.apply(this.port.submitted(id, requestId));
  }
  claimReply(id: string, text: string) {
    return this.apply(this.port.claimReply(id, text));
  }
  interruptUncertain() {
    return this.apply(this.port.interruptUncertain());
  }
  prune() {
    return this.apply(this.port.prune());
  }

  // Configuration writes resolve after the commit, with the projection replaced.
  saveChannel(config: ChannelConfig, enabled: boolean, expected: number | null) {
    return this.apply(this.port.saveChannel(config, enabled, expected));
  }
  route(id: string, expected: number, source: string | null, publish: boolean) {
    return this.apply(this.port.route(id, expected, source, publish));
  }
  removeChannel(id: string) {
    return this.apply(this.port.removeChannel(id));
  }
  linkSender(id: string, sender: string, actor: string) {
    return this.apply(this.port.linkSender(id, sender, actor));
  }
  unlinkSender(id: string, sender: string) {
    return this.apply(this.port.unlinkSender(id, sender));
  }
  challenge(hash: string, id: string, actor: string) {
    return this.apply(this.port.challenge(hash, id, actor));
  }
  /**
   * Validates the pending challenge's actor on this thread, then links the
   * sender only if the owner still holds that same challenge.
   */
  async consumeChallenge(
    hash: string,
    id: string,
    sender: string,
    validate: (actor: string) => void = () => {},
  ): Promise<string | null> {
    const actor = await this.port.peekChallenge(hash, id);
    if (!actor) return null;
    validate(actor);
    return this.apply(this.port.consumeChallenge(hash, id, sender, actor));
  }

  private async apply<T>(pending: Promise<SwitchboardChange<T>>): Promise<T> {
    const change = await pending;
    if (change.config) this.config = change.config;
    if (change.anchors) this.replaceAnchors(change.anchors);
    if (change.anchor) {
      const prior = this.anchors.get(change.anchor.id);
      if (prior?.reply_ref) this.anchorsByReply.delete(prior.reply_ref);
      this.anchors.delete(change.anchor.id);
      if (change.anchor.row) this.storeAnchor(change.anchor.row);
    }
    return change.value;
  }
  private replaceAnchors(rows: readonly ReplyAnchor[]) {
    this.anchors.clear();
    this.anchorsByReply.clear();
    for (const row of rows) this.storeAnchor(row);
  }
  private storeAnchor(row: ReplyAnchor) {
    this.anchors.set(row.id, row);
    if (row.reply_ref) this.anchorsByReply.set(row.reply_ref, row);
  }
  private current(reference: string): ReplyAnchor[] {
    const since = Date.now() - RETENTION;
    return [...this.anchors.values()]
      .filter((m) => m.conversation_ref === reference && m.created_at >= since)
      .sort(newestFirst)
      .map((m) => ({ ...m }));
  }
}
