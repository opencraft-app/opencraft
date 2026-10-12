import type { IMMessage } from "@vela/im-client";

/** View models for the IM panel. The SDK returns Tencent IM objects; these normalizers narrow them once. */
export type ConversationKind = "C2C" | "GROUP" | "SYSTEM";

export interface ConversationItem {
  conversationID: string;
  kind: ConversationKind;
  /** userID for C2C, groupID for GROUP. */
  targetID: string;
  name: string;
  lastText: string;
  lastTime: number;
  unread: number;
  isPinned: boolean;
  memberCount?: number;
}

export interface ContactItem {
  userID: string;
  name: string;
  remark?: string;
}

export interface MemberItem {
  userID: string;
  name: string;
  role: "Owner" | "Admin" | "Member";
}

export interface ApplicationItem {
  userID: string;
  name: string;
  wording: string;
  direction: "incoming" | "outgoing";
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const dict = (value: unknown): Dict => (isDict(value) ? value : {});

/** Vela IM IDs encode the identity kind: `a_` for Agents, `h_` for humans. */
export const isAgentID = (id: string | undefined | null): boolean => typeof id === "string" && id.startsWith("a_");

export const toConversation = (raw: unknown): ConversationItem | null => {
  const c = dict(raw);
  const conversationID = str(c.conversationID);
  if (!conversationID) return null;
  const type = str(c.type);
  const group = dict(c.groupProfile);
  const user = dict(c.userProfile);
  const last = dict(c.lastMessage);
  const kind: ConversationKind = type === "GROUP" ? "GROUP" : type === "C2C" ? "C2C" : "SYSTEM";
  const targetID = kind === "GROUP" ? str(group.groupID) || conversationID.replace(/^GROUP/, "") : str(user.userID) || conversationID.replace(/^C2C/, "");
  const name = kind === "GROUP" ? str(group.name) || targetID : str(c.remark) || str(user.nick) || targetID;
  return {
    conversationID,
    kind,
    targetID,
    name: kind === "SYSTEM" ? "" : name,
    lastText: last.isRevoked ? "" : last.type === "TIMCustomElem" && groupCreateNotice(dict(last.payload)) ? "" : str(last.messageForShow),
    lastTime: num(last.lastTime),
    unread: num(c.unreadCount),
    isPinned: c.isPinned === true,
    ...(kind === "GROUP" && num(group.memberCount) ? { memberCount: num(group.memberCount) } : {}),
  };
};

export const toConversations = (raw: unknown): ConversationItem[] =>
  (Array.isArray(raw) ? raw : [])
    .map(toConversation)
    .filter((c): c is ConversationItem => c !== null && c.kind !== "SYSTEM")
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.lastTime - a.lastTime);

export const toContacts = (raw: unknown): ContactItem[] =>
  (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const f = dict(item);
    const userID = str(f.userID);
    if (!userID) return [];
    const profile = dict(f.profile);
    const remark = str(f.remark);
    return [{ userID, name: remark || str(profile.nick) || userID, ...(remark ? { remark } : {}) }];
  });

export const toMembers = (raw: unknown): MemberItem[] =>
  (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const m = dict(item);
    const userID = str(m.userID);
    if (!userID) return [];
    const role = str(m.role);
    return [{ userID, name: str(m.nameCard) || str(m.nick) || userID, role: role === "Owner" || role === "Admin" ? role : "Member" }];
  });

export const toApplications = (raw: unknown): ApplicationItem[] =>
  (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const a = dict(item);
    const userID = str(a.userID);
    if (!userID) return [];
    return [{ userID, name: str(a.nick) || userID, wording: str(a.wording) || str(a.word), direction: a.direction === "outgoing" ? "outgoing" : "incoming" }];
  });

/** Group lifecycle notices rendered as a centered system line instead of a chat bubble. */
export type GroupEventKind = "created" | "joined" | "quit" | "kicked" | "admin_set" | "admin_canceled" | "profile_updated";

// Tencent IM group tip operation types (TIM.TYPES.GRP_TIP_*).
const GROUP_TIP_EVENTS: Record<number, GroupEventKind> = { 1: "joined", 2: "quit", 3: "kicked", 4: "admin_set", 5: "admin_canceled", 6: "profile_updated" };

/** Tencent's group-creation notice: a custom message whose data is `{"businessID":"group_create",...}`. */
const groupCreateNotice = (payload: Dict): { operator: string } | null => {
  try {
    const data = JSON.parse(str(payload.data)) as unknown;
    return isDict(data) && data.businessID === "group_create" ? { operator: str(data.opUser) } : null;
  } catch {
    return null;
  }
};

export type MessageView =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; fullUrl: string }
  | { kind: "audio"; url: string; seconds: number }
  | { kind: "video"; url: string; poster: string }
  | { kind: "file"; url: string; name: string; size: number }
  | { kind: "location"; description: string; latitude: number; longitude: number }
  | { kind: "face"; data: string }
  | { kind: "merger"; title: string; abstracts: string[] }
  | { kind: "custom"; description: string; data: string }
  | { kind: "tip"; text: string }
  | { kind: "event"; event: GroupEventKind; operator: string; targets: string[] }
  | { kind: "revoked" }
  | { kind: "unknown"; label: string };

const httpURL = (value: unknown): string => {
  const url = str(value);
  return /^https?:\/\//.test(url) ? url : "";
};

/** Maps every message type Tencent IM can deliver to something renderable; unknown types stay visible. */
export const describeMessage = (message: IMMessage): MessageView => {
  if (message.isRevoked) return { kind: "revoked" };
  const p = dict(message.payload);
  switch (message.type) {
    case "TIMTextElem":
      return { kind: "text", text: str(p.text) };
    case "TIMImageElem": {
      const images = Array.isArray(p.imageInfoArray) ? p.imageInfoArray.map(dict) : [];
      return { kind: "image", url: httpURL(images[0]?.url) || httpURL(images.at(-1)?.url), fullUrl: httpURL(images.at(-1)?.url) || httpURL(images[0]?.url) };
    }
    case "TIMSoundElem":
      return { kind: "audio", url: httpURL(p.url) || httpURL(p.remoteAudioUrl), seconds: num(p.second) };
    case "TIMVideoFileElem":
      return { kind: "video", url: httpURL(p.videoUrl) || httpURL(p.remoteVideoUrl), poster: httpURL(p.snapshotUrl) };
    case "TIMFileElem":
      return { kind: "file", url: httpURL(p.fileUrl), name: str(p.fileName) || "file", size: num(p.fileSize) };
    case "TIMLocationElem":
      return { kind: "location", description: str(p.description), latitude: num(p.latitude), longitude: num(p.longitude) };
    case "TIMFaceElem":
      return { kind: "face", data: str(p.data) || `#${num(p.index)}` };
    case "TIMRelayElem":
      return { kind: "merger", title: str(p.title), abstracts: Array.isArray(p.abstractList) ? p.abstractList.map(str).filter(Boolean) : [] };
    case "TIMCustomElem": {
      const created = groupCreateNotice(p);
      if (created) return { kind: "event", event: "created", operator: created.operator, targets: [] };
      return { kind: "custom", description: str(p.description), data: str(p.data) };
    }
    case "TIMGroupTipElem": {
      const event = GROUP_TIP_EVENTS[num(p.operationType)];
      if (event) {
        const members = Array.isArray(p.memberList) ? p.memberList.map((m) => str(dict(m).userID)) : [];
        const targets = Array.isArray(p.userIDList) && p.userIDList.length ? p.userIDList.map(str) : members;
        return { kind: "event", event, operator: str(p.operatorID), targets: targets.filter(Boolean) };
      }
      return { kind: "tip", text: str(dict(message).messageForShow) || str(p.text) };
    }
    case "TIMGroupSystemNoticeElem":
      return { kind: "tip", text: str(dict(message).messageForShow) || str(p.text) };
    default:
      return { kind: "unknown", label: str(message.type) || "message" };
  }
};

/** Merges a batch into the current list by ID and keeps chronological order (sequence breaks same-second ties). */
export const mergeMessages = (current: IMMessage[], incoming: IMMessage[]): IMMessage[] => {
  const byID = new Map(current.map((m) => [m.ID, m]));
  for (const message of incoming) byID.set(message.ID, message);
  return [...byID.values()].sort((a, b) => num(a.time) - num(b.time) || num(a.sequence) - num(b.sequence));
};

/** Revoke events from Tencent IM V4 carry only conversationID + sequence; match either form. */
export const applyRevoked = (current: IMMessage[], revoked: IMMessage[]): IMMessage[] =>
  current.map((m) =>
    revoked.some((r) => r.ID === m.ID || (r.conversationID === m.conversationID && r.sequence !== undefined && r.sequence === m.sequence))
      ? { ...m, isRevoked: true }
      : m,
  );

export interface MentionCandidate {
  userID: string;
  name: string;
}

/**
 * Resolves `@name` / `@userID` tokens in a group message to Tencent `atUserList` entries.
 * `@所有人` / `@all` mention everyone.
 */
export const resolveMentions = (text: string, members: MentionCandidate[]): string[] => {
  const ids = new Set<string>();
  const byLongestName = [...members].sort((a, b) => b.name.length - a.name.length);
  for (const member of byLongestName) {
    if (text.includes(`@${member.userID}`) || (member.name && text.includes(`@${member.name}`))) ids.add(member.userID);
  }
  if (/@(?:所有人|all)(?=$|\s|[，。！？,.!?])/i.test(text)) ids.add("@all");
  return [...ids];
};

/** Splits pasted member lists (newline, comma, Chinese comma, space) into unique IDs. */
export const parseIDs = (value: string): string[] => [...new Set(value.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean))];

export const formatTime = (seconds: number, now = Date.now()): string => {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
};

export const errorText = (error: unknown, fallback: string): string => {
  if (isDict(error)) {
    const message = str(error.message) || str(error.error) || str(error.ErrorInfo);
    if (message) return message;
  }
  return typeof error === "string" && error ? error : fallback;
};
