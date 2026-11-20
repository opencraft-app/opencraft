export const CHANNELS_HOST_ID = "opencraft-channels";
export const CHANNELS_EXTENSION = "opencraft/channels";
export const CHANNELS_CHANGED = "opencraft/channels/changed";
export const CHANNEL_AVATAR_PARTICIPANT_LIMIT = 4;

/** Server-owned outbound display facts. Never an ActorContext or authority grant.
 * Content and delivery anchors remain in the existing outbound envelope. */
export interface ChannelMessagePresentation {
  version: 1;
  sender: { id: string; role: "human" | "agent" | "assistant" | "system"; displayName: string };
  format: "text" | "markdown";
}

/** Installation-verified presentation key, never a caller-supplied URL or a grant. */
export interface ChannelIdentityAvatar { kind: string; name: string }
export interface ChannelActor {
  actorId: string;
  displayName: string;
  actorKind: "human" | "session";
  avatar?: ChannelIdentityAvatar;
}

export interface ChannelSummary {
  id: string;
  title: string;
  canSend: boolean;
  unreadCount?: number;
  mentionUnreadCount?: number;
  firstUnreadMentionSequence?: number;
  /** Current Inbox projection; absent when this transport has no Inbox capability. */
  latestMessage?: import("./actor-inbox.js").ActorInboxMessage | null;
  kind?: "direct" | "group";
  /** Native lifecycle capability; absence means an older/unsupported Server. */
  lifecycle?: { state: 'active' | 'dissolved'; revision: number; dissolvedAt: number | null; canLeave: boolean; canDissolve: boolean };
  /** Per-actor persisted list preference, never membership or history authority. */
  listState?: { hidden: boolean };
  canManageMembers?: boolean;
  /** Only the group owner can rename it, like membership administration. */
  canRename?: boolean;
  /** Direct peer or a stable, bounded group preview. Not the authoritative roster. */
  participants?: ChannelActor[];
}

export type ChannelInviteCandidate = ChannelActor;

export interface ChannelMember extends ChannelInviteCandidate {
  role: "owner" | "member";
  canWake?: boolean;
  /** Installation projection; linked means identity is verified, not delivery guaranteed. */
  mentionDelivery?: "native-only" | "linked";
}

/** Installation-owned external group metadata; null for native/unsupported groups. */
export interface ChannelGroupSyncStatus {
  provider: string;
  /** This source cannot identify ordinary members targeted by inbound @text. */
  mentionIngress?: "text-only";
  configured: boolean;
  canRefresh: boolean;
  state: 'never' | 'idle' | 'pending' | 'syncing' | 'error' | 'paused' | 'disconnected';
  lastSyncedAt: number | null;
  lastAttemptAt: number | null;
  name: 'off' | 'inbound' | 'both';
  members: 'observe' | 'inbound' | 'both';
  pendingOperations: number;
  /** Outstanding latest-intent delivery failure; no external identities or raw errors. */
  deliveryIssue?: {
    action: 'rename' | 'add' | 'remove';
    reason: 'owner_required' | 'rejected' | 'conflict';
  };
}

export type ChannelDelivery = "delivered" | "rejected" | "unknown";

export interface ChannelMessageSender {
  /** Opaque, stable within this channel. */
  id: string;
  /** The sender's name as recorded when the message was accepted. */
  displayName: string;
  kind: "opencraft" | "external";
  /** Trusted, provider-owned photo key. Never inferred from displayName or a client-supplied URL. */
  avatar?: ChannelIdentityAvatar;
  actorKind?: "human" | "session";
  /** Viewer-specific. Omitted when the viewer's relation to the sender is unknown. */
  isSelf?: boolean;
}

/** Selected native member identity and UTF-16 offsets into the exact message text. */
export interface ChannelMentionInput { actorId: string; start: number; end: number }
/** Historical label snapshot; isSelf is projected relative to the authenticated reader. */
export interface ChannelMention extends ChannelMentionInput { displayName: string; actorKind: "human" | "session"; isSelf?: boolean; isUnread?: boolean }
/** Sequence is the stable message identifier within a channel, independent of sync. */
export interface ChannelMessage {
  sequence: number;
  messageId?: string;
  /** Monotonic projection revision for a native message. */
  revision?: number;
  replyToMessageId?: string;
  replyTo?: { author: string; text: string };
  mentions?: ChannelMention[];
  executionRequests?: { actorId: string; requestId: string }[];
  /** Legacy author projection for clients and records without structured sender data. */
  author: string;
  sender?: ChannelMessageSender;
  text: string;
  at: number;
  status: "received" | "sending" | ChannelDelivery;
  attachment?: { name: string; type: string; size: number };
  image?: { state: "pending" | "ready" | "unavailable"; attribution?: "sending" | ChannelDelivery };
}

/** Native history only. Includes synchronized external messages, not remote provider search. */
export interface ChannelSearchPage {
  matches: { channel: ChannelSummary; message: ChannelMessage }[];
  nextBefore: number | null;
}

export interface ChannelHistoryPage {
  messages: ChannelMessage[];
  hasEarlier: boolean;
}

/** Delta pages contain current message projections, including updates to old messages. */
export type ChannelSyncPage =
  | (ChannelHistoryPage & { kind: "snapshot"; cursor: string })
  | { kind: "delta"; messages: ChannelMessage[]; cursor: string; hasMore: boolean };

export interface ChannelChanged {
  subscriptionId: string;
}

export interface ChannelPerson { actorId: string; displayName: string; kind: 'human' | 'bot'; canMessage: boolean; avatar?: ChannelIdentityAvatar }
/** Someone a space Bot may proactively reach (one-way); `session` entries are Bots. */
export interface CrewPhonebookEntry { actorId: string; displayName: string; kind: 'human' | 'session' }
/** A Bot's phonebook as one member sees it: entries, the space members who could be entries, and edit rights. */
export interface CrewPhonebook { entries: CrewPhonebookEntry[]; members: CrewPhonebookEntry[]; editable: boolean }
/** One piece of crew work and the people it answers to, nearest first, the space owner last. */
export interface CrewWorkView {
  id: string; state: 'open' | 'closed'; origin: 'member' | 'bot' | 'routine';
  assigneeId: string; requesterId: string; parentId: string | null; rootId: string; messageId: string | null;
  chain: CrewPhonebookEntry[]; budget: { used: number; limit: number };
  /** Dispatch text, visible to the assignee and the requester only; null otherwise or for routine work. */
  request: string | null;
}
export interface ChannelsMethodMap {
  'opencraft/channels/group/get': {params:{channelId:string};result:ChannelSummary};
  'opencraft/channels/group/list-state/set': {params:{channelId:string;hidden:boolean;clientRequestId:string};result:ChannelSummary};
  'opencraft/channels/group/leave': {params:{channelId:string;clientRequestId:string};result:null};
  'opencraft/channels/group/dissolve': {params:{channelId:string;expectedRevision:number;clientRequestId:string};result:ChannelSummary};
  'opencraft/channels/group/sync/status': {params:{channelId:string};result:ChannelGroupSyncStatus|null};
  'opencraft/channels/group/sync/refresh': {params:{channelId:string;clientRequestId:string};result:ChannelGroupSyncStatus};
  'opencraft/channels/records/resource/read': {params:{channelId:string;sequence:number;path:string;offset:number};result:{name:string;type:string;size:number;revision:string;base64:string;nextOffset:number}|null};
  "opencraft/channels/messages/around":{params:{channelId:string;sequence:number};result:ChannelHistoryPage};
  "opencraft/channels/search": {params:{query:string;before?:number;limit?:number};result:ChannelSearchPage};
  'opencraft/channels/attachments/upload': {params:{channelId:string;clientMessageId:string;name:string;type:string;text?:string;total:number;offset:number;base64:string};result:{nextOffset:number;receipt?:ChannelMessage}};
  'opencraft/channels/attachments/send': {params:{channelId:string;clientMessageId:string;name:string;type:string;base64:string;text?:string};result:{receipt:ChannelMessage}};
  'opencraft/channels/attachments/read': {params:{channelId:string;sequence:number;offset:number};result:{name:string;type:string;size:number;base64:string;nextOffset:number}|null};
  'opencraft/channels/attachments/get': {params:{channelId:string;sequence:number};result:{name:string;type:string;base64:string}|null};
  'opencraft/channels/people/list': {params:{after?:string;query?:string};result:{people:ChannelPerson[];next:string|null}};
  "opencraft/inbox/sync": {params:{cursor?:string;limit?:number};result:import('./actor-inbox.js').ActorInboxPage};
  "opencraft/channels/mentions/ack": {params:{channelId:string;messageId:string};result:{acknowledged:boolean}};
  "opencraft/channels/read": {params:{channelId:string;throughSequence:number};result:null};
  "opencraft/channels/list": { params: Record<string, never>; result: { groups: ChannelSummary[] } };
  "opencraft/channels/direct/open": { params: { actorId: string }; result: ChannelSummary };
  /** Readable by members of the Bot's space; only the space owner edits it, with members of that space. */
  "opencraft/crew/phonebook/list": { params: { botId: string }; result: CrewPhonebook };
  "opencraft/crew/phonebook/set": { params: { botId: string; actorId: string; present: boolean }; result: CrewPhonebook };
  /** Members (same space) or Bots (phonebook, under an open parent) hand work to a space Bot. */
  "opencraft/crew/work/dispatch": { params: { targetActorId: string; content: string; idempotencyKey: string; parentWorkId?: string }; result: { messageId: string; workId: string; work: CrewWorkView } };
  /** The assignee of open work reaches anyone on its chain, or the space owner. */
  "opencraft/crew/work/message": { params: { workId: string; targetActorId: string; content: string; idempotencyKey: string }; result: { messageId: string } };
  "opencraft/crew/work/start": { params: Record<string, never>; result: { work: CrewWorkView } };
  "opencraft/crew/work/finish": { params: { workId: string }; result: { work: CrewWorkView } };
  "opencraft/crew/work/get": { params: { workId: string }; result: { work: CrewWorkView } };
  "opencraft/crew/work/list": { params: Record<string, never>; result: { works: CrewWorkView[] } };
  "opencraft/channels/group/create": {
    params: { title: string; memberActorIds: string[]; clientRequestId: string };
    result: ChannelSummary;
  };
  "opencraft/channels/group/member/set": {
    params: { channelId: string; actorId: string; present: boolean; clientRequestId: string };
    result: null;
  };
  "opencraft/channels/group/rename": {
    params: { channelId: string; title: string; clientRequestId: string };
    result: ChannelSummary;
  };
  "opencraft/channels/group/members/list": { params: { channelId: string }; result: { members: ChannelMember[] } };
  "opencraft/channels/group/candidates/search": {
    params: { query: string; channelId?: string };
    result: { candidates: ChannelInviteCandidate[] };
  };
  "opencraft/channels/messages/search": {params:{channelId:string;query:string;before?:number;limit?:number};result:ChannelHistoryPage};
  "opencraft/channels/messages/list": { params: { channelId: string; before?: number }; result: ChannelHistoryPage };
  "opencraft/channels/sync": { params: { channelId: string; cursor?: string }; result: ChannelSyncPage };
  "opencraft/channels/subscribe": { params: { channelId?: string; subscriptionId: string }; result: null };
  "opencraft/channels/unsubscribe": { params: { subscriptionId: string }; result: null };
  "opencraft/channels/messages/send": {
    params: { channelId: string; clientMessageId: string; parts: [{ type: "text"; text: string }]; replyToMessageId?: string; wakeActorIds?: string[]; mentions?: ChannelMentionInput[] };
    result: { receipt: ChannelMessage };
  };
  "opencraft/channels/delivery/get": {
    params: { channelId: string; clientMessageId: string };
    result: { receipt: ChannelMessage | null };
  };
}
