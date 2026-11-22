import type { ConversationRef } from "@opencraft/appserver-protocol/collaboration";
import { SwitchboardStore, type Channel, type ChannelConfig, type ReplyAnchor, type StoredMessage } from "./store.js";

/** Channel configuration a network thread keeps in memory. */
export interface SwitchboardConfig {
  readonly channels: Channel[];
  readonly channelIds: string[];
  readonly links: Record<string, Record<string, string>>;
  readonly versions: Record<string, unknown[]>;
}

/** A write's result with the projection state it changed. */
export interface SwitchboardChange<T = void> {
  readonly value: T;
  /** Replaces the configuration projection when present. */
  readonly config?: SwitchboardConfig;
  /** Replaces every anchor when present. */
  readonly anchors?: ReplyAnchor[];
  /** Replaces one message's anchor (null removes it) when present. */
  readonly anchor?: { readonly id: string; readonly row: ReplyAnchor | null };
}

class ChallengeChanged extends Error {}

/**
 * The switchboard as its storage owner serves it. Reads that need the full
 * message stay here; every write returns what changed in the projection, so
 * the network thread never reads SQLite to stay current.
 */
export class SwitchboardOwner {
  constructor(private readonly store: SwitchboardStore) {}

  get outcome() {
    return this.store.outcome;
  }
  snapshot() {
    return { outcome: this.store.outcome, config: this.config(), anchors: this.store.anchors() };
  }
  close() {
    this.store.close();
  }

  // Message reads.
  get(endpointId: string, sourceKey: string) {
    return this.store.get(endpointId, sourceKey);
  }
  message(id: string) {
    return this.store.message(id);
  }
  replyReference(ref: string) {
    return this.store.replyReference(ref);
  }
  readableMessages(reference: string, channelId: string, actorId: string) {
    return this.store.readableMessages(reference, channelId, actorId);
  }
  messages(id: string, limit?: number) {
    return this.store.messages(id, limit);
  }
  recoverable(channelId: string) {
    return this.store.recoverable(channelId);
  }
  peekChallenge(hash: string, id: string) {
    return this.store.peekChallenge(hash, id);
  }

  // Message writes.
  bind(endpointId: string, sourceKey: string, ref: ConversationRef): SwitchboardChange {
    this.store.bind(endpointId, sourceKey, ref);
    return { value: undefined };
  }
  accept(m: Parameters<SwitchboardStore["accept"]>[0]): SwitchboardChange {
    // accept prunes first; reload anchors only if pruning changed rows.
    const changed = this.store.prune();
    this.store.accept(m);
    return { value: undefined, ...(changed ? { anchors: this.store.anchors() } : {}) };
  }
  patch(id: string, value: Parameters<SwitchboardStore["patch"]>[1]): SwitchboardChange {
    this.store.patch(id, value);
    return { value: undefined, anchor: this.anchor(id) };
  }
  submitted(id: string, requestId: string): SwitchboardChange {
    this.store.submitted(id, requestId);
    return { value: undefined, anchor: this.anchor(id) };
  }
  claimReply(id: string, text: string): SwitchboardChange<boolean> {
    return { value: this.store.claimReply(id, text), anchor: this.anchor(id) };
  }
  interruptUncertain(): SwitchboardChange {
    this.store.interruptUncertain();
    return { value: undefined, anchors: this.store.anchors() };
  }
  prune(): SwitchboardChange {
    return this.store.prune() ? { value: undefined, anchors: this.store.anchors() } : { value: undefined };
  }

  // Configuration writes.
  saveChannel(config: ChannelConfig, enabled: boolean, expected: number | null): SwitchboardChange<Channel> {
    return { value: this.store.saveChannel(config, enabled, expected), config: this.config() };
  }
  route(id: string, expected: number, source: string | null, publish: boolean): SwitchboardChange<Channel> {
    return { value: this.store.route(id, expected, source, publish), config: this.config() };
  }
  removeChannel(id: string): SwitchboardChange {
    this.store.removeChannel(id);
    return { value: undefined, config: this.config() };
  }
  linkSender(id: string, sender: string, actor: string): SwitchboardChange {
    this.store.linkSender(id, sender, actor);
    return { value: undefined, config: this.config() };
  }
  unlinkSender(id: string, sender: string): SwitchboardChange {
    this.store.unlinkSender(id, sender);
    return { value: undefined, config: this.config() };
  }
  challenge(hash: string, id: string, actor: string): SwitchboardChange {
    // Issuing a challenge also expires overdue explicit replies.
    this.store.challenge(hash, id, actor);
    return { value: undefined, anchors: this.store.anchors() };
  }
  /** Links the sender only if the challenge still names the actor the caller validated. */
  consumeChallenge(hash: string, id: string, sender: string, expected: string): SwitchboardChange<string | null> {
    try {
      const actor = this.store.consumeChallenge(hash, id, sender, (actor) => {
        if (actor !== expected) throw new ChallengeChanged();
      });
      return { value: actor, config: this.config() };
    } catch (error) {
      if (error instanceof ChallengeChanged) return { value: null };
      throw error;
    }
  }

  private anchor(id: string) {
    return { id, row: this.store.anchors(id)[0] ?? null };
  }
  private config(): SwitchboardConfig {
    const channels = this.store.channels();
    return {
      channels,
      channelIds: this.store.channelIds(),
      links: this.store.allSenderLinks(),
      versions: Object.fromEntries(channels.map((c) => [c.id, this.store.versions(c.id) as unknown[]])),
    };
  }
}

export type { StoredMessage };
