import type { DatabaseSync } from "node:sqlite";
import type { Collaboration } from "./collaboration.js";
import type { PersonalAssistants } from "./personal-assistants.js";
import type { ActorContext } from "@opencraft/identity-core/actors";

/** Trusted installation composition only. No client-selected modules or provider
 * semantics. Callbacks execute inside the existing communication transaction. */
export interface CommunicationExtension {
  /** Installation-owned metadata replication. Never reachable from client-selected sync RPCs.
   * Answers only installation-owned methods; returns undefined for core `ChannelSyncMethod`s,
   * whose results are declared by `ChannelSyncResults`. */
  synchronize?(
    service: Collaboration,
    db: DatabaseSync,
    command: import("./native-channel-sync.js").ChannelSyncCommand,
  ): { result: unknown; changes: import("./native-channels.js").NativeChannelChange[] } | undefined;
  /** Presentation only; provider labels cannot grant access or become explicit names. */
  /** Installation declares generic outbound file transport; never grants read/send authority. */
  channelFiles?(source: string): boolean;
  groupDisplayTitle?(service: Collaboration, db: DatabaseSync, id: string): string | null;
  groupMutation?(
    service: Collaboration,
    db: DatabaseSync,
    context: ActorContext,
    id: string,
    key: string,
    change: Record<string, unknown>,
  ): void;
  /** Queue an external group for a just-created native group, inside the same transaction. */
  groupCreated?(
    service: Collaboration,
    db: DatabaseSync,
    context: ActorContext,
    id: string,
    input: { title: string; members: string[] },
  ): void;
  /** A verified external sender's local human, for viewer-relative presentation only. */
  senderHuman?(
    service: Collaboration,
    db: DatabaseSync,
    subject: import("./native-channels.js").ChannelExternalSender,
    scope: import("./native-channels.js").ChannelSenderReadScope,
  ): string | null;
  avatar?(
    service: Collaboration,
    db: DatabaseSync,
    subject: import("./native-channels.js").ChannelAvatarSubject,
    scope: import("./native-channels.js").AvatarReadScope,
  ): import("./native-channels.js").ChannelAvatar | null;
  fingerprint?(arrival: import("./native-channel-sync.js").ChannelArrival): unknown[];
  arrival?(
    service: Collaboration,
    db: DatabaseSync,
    arrival: import("./native-channel-sync.js").ChannelArrival,
    source: Record<string, unknown>,
    messageId: string,
  ): void;
  nativeMessage?(
    service: Collaboration,
    db: DatabaseSync,
    context: ActorContext,
    channelId: string,
    messageId: string,
    text: string,
    target?: string,
  ): boolean;
  mentionDelivery?(
    service: Collaboration,
    db: DatabaseSync,
    channelId: string,
    actorId: string,
  ): "native-only" | "linked" | undefined;
  deliveryAllowed?(service: Collaboration, db: DatabaseSync, delivery: Record<string, unknown>): boolean | undefined;
  /** Installation maps explicit native identities to verified recipients in this source only. */
  outboundMentions?(
    service: Collaboration,
    db: DatabaseSync,
    delivery: Record<string, unknown>,
    mentions: import("@opencraft/appserver-protocol").ChannelMention[],
  ): { start: number; end: number; recipient: string }[];
  /** Provider message this queued delivery answers; transports may thread or stream the reply under it. */
  replyTarget?(db: DatabaseSync, messageId: string): string | undefined;
  /** Source-owned display policy after delivery authorization, never inferred from a name. */
  outboundPresentation?(
    service: Collaboration,
    db: DatabaseSync,
    delivery: Record<string, unknown>,
  ):
    | {
        role: import("@opencraft/appserver-protocol").ChannelMessagePresentation["sender"]["role"];
        format: import("@opencraft/appserver-protocol").ChannelMessagePresentation["format"];
      }
    | undefined;
  command?(
    service: Collaboration,
    db: DatabaseSync,
    assistants: PersonalAssistants,
    context: ActorContext,
    method: string,
    params: Record<string, unknown>,
  ):
    | { result: unknown; personalReadGuard?: { epoch: string; groups: { id: string; epoch: string | null }[] } }
    | undefined;
}
let extension: CommunicationExtension | undefined, moduleURL: string | undefined;
export function installCommunicationExtension(value: CommunicationExtension, url?: string) {
  if (extension && extension !== value) throw Error("Communication extension already installed");
  extension = value;
  moduleURL = url;
}
export const communicationExtension = () => extension;
export const communicationExtensionModule = () => moduleURL;
