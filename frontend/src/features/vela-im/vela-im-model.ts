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

/** Vela IM IDs encode the identity kind: `a_` for Agents (Bots), `u_` for humans. */
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
    lastText: last.isRevoked || (last.type === "TIMCustomElem" && (groupCreateNotice(dict(last.payload)) || agentStatus(last as IMMessage))) ? "" : str(last.messageForShow),
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
export type GroupEventKind = "created" | "joined" | "quit" | "kicked" | "admin_set" | "admin_canceled" | "profile_updated" | "reply_mode_changed";

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

/** The platform's reply-rule notice: `{"businessID":"vela_group_policy","replyMode":...}`. */
const replyModeNotice = (payload: Dict): { mode: string } | null => {
  try {
    const data = JSON.parse(str(payload.data)) as unknown;
    return isDict(data) && data.businessID === "vela_group_policy" ? { mode: str(data.replyMode) } : null;
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

/** Remote media, or the browser's local preview (`blob:`) on a message this tab just sent. */
const httpURL = (value: unknown): string => {
  const url = str(value);
  return /^(https?:\/\/|blob:)/.test(url) ? url : "";
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
      const urlOf = (image: Dict | undefined) => httpURL(image?.url) || httpURL(image?.imageUrl);
      return { kind: "image", url: urlOf(images[0]) || urlOf(images.at(-1)), fullUrl: urlOf(images.at(-1)) || urlOf(images[0]) };
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
      // The new mode travels in `operator` so the system line can name it.
      const policy = replyModeNotice(p);
      if (policy) return { kind: "event", event: "reply_mode_changed", operator: policy.mode, targets: [] };
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
export const resolveMentions = (text: string, members: MentionCandidate[], picked: MentionCandidate[] = []): string[] => {
  const ids = new Set<string>();
  let rest = text;
  /** Each `@token` resolves once, so `@助手` never also matches inside `@研究助手`. */
  const take = (token: string) => {
    const at = rest.indexOf(token);
    if (at < 0) return false;
    rest = rest.slice(0, at) + " ".repeat(token.length) + rest.slice(at + token.length);
    return true;
  };
  for (const member of members) if (take(`@${member.userID}`)) ids.add(member.userID);
  // Longest names first; at equal length an identity picked from the list wins, since members can share a name.
  // A typed name shared by several members is ambiguous, so only a pick resolves it.
  const candidates = [
    ...picked.filter((p) => p.name).map((p) => ({ ...p, picked: true })),
    ...members.filter((m) => m.name && members.filter((x) => x.name === m.name).length === 1).map((m) => ({ ...m, picked: false })),
  ].sort((a, b) => b.name.length - a.name.length || Number(b.picked) - Number(a.picked));
  for (const candidate of candidates) if (take(`@${candidate.name}`)) ids.add(candidate.userID);
  if (/@(?:所有人|all)(?=$|\s|[，。！？,.!?])/i.test(text)) ids.add("@all");
  return [...ids];
};

/** Splits pasted member lists (newline, comma, Chinese comma, space) into unique IDs. */
export const parseIDs = (value: string): string[] => [...new Set(value.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean))];

/** An Agent's online-only "working on it" signal; it is shown as an indicator, never as a message. */
export const agentStatus = (message: IMMessage): { state: "working" | "idle"; messageID: string } | null => {
  if (message.type !== "TIMCustomElem") return null;
  try {
    const data = JSON.parse(str(dict(message.payload).data)) as unknown;
    if (!isDict(data) || data.businessID !== "vela_agent_status") return null;
    return { state: data.state === "working" ? "working" : "idle", messageID: str(data.messageID) };
  } catch {
    return null;
  }
};

/** URL parameter carrying a group invite; the chat page joins the group and opens it. */
export const GROUP_INVITE_PARAM = "imInvite";

export const groupInviteLink = (origin: string, token: string): string =>
  `${origin}/agents/chat?${GROUP_INVITE_PARAM}=${encodeURIComponent(token)}`;

/** Agents working in each conversation: conversationID → agent userID → when its last signal expires (ms). */
export type WorkingAgents = Record<string, Record<string, number>>;

/** An Agent re-announces "working" every 8 seconds; past this it has stopped or gone offline. */
export const WORKING_TTL_MS = 20_000;

export const applyAgentStatus = (old: WorkingAgents, signals: IMMessage[], now = Date.now()): WorkingAgents => {
  const next: WorkingAgents = { ...old };
  for (const signal of signals) {
    const status = agentStatus(signal);
    const conversationID = str(signal.conversationID);
    if (!status || !signal.from || !conversationID) continue;
    const agents = { ...(next[conversationID] ?? {}) };
    if (status.state === "working") agents[signal.from] = now + WORKING_TTL_MS;
    else delete agents[signal.from];
    if (Object.keys(agents).length) next[conversationID] = agents;
    else delete next[conversationID];
  }
  return next;
};

export const pruneWorking = (old: WorkingAgents, now = Date.now()): WorkingAgents => {
  const next: WorkingAgents = {};
  for (const [conversationID, agents] of Object.entries(old)) {
    const alive = Object.fromEntries(Object.entries(agents).filter(([, until]) => until > now));
    if (Object.keys(alive).length) next[conversationID] = alive;
  }
  return next;
};

/** One-line preview of a message, used when quoting it. */
export const messageAbstract = (message: IMMessage): string => {
  const view = describeMessage(message);
  const label: Partial<Record<MessageView["kind"], string>> = {
    image: "[图片]", audio: "[语音]", video: "[视频]", face: "[表情]", merger: "[聊天记录]", revoked: "[已撤回]",
  };
  const text = view.kind === "text" ? view.text
    : view.kind === "file" ? `[文件] ${view.name}`
      : view.kind === "location" ? `[位置] ${view.description}`
        : view.kind === "custom" ? view.description || "[自定义消息]"
          : label[view.kind] ?? "[消息]";
  const line = text.replace(/\*\*|__|`+|^#{1,6}\s+|^>\s+/gm, "").replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

export interface QuotedMessage {
  messageID: string;
  sender: string;
  abstract: string;
}

/** Tencent IM's reply convention (`cloudCustomData.messageReply`), shared with other Tencent clients. */
export const quotedMessage = (message: IMMessage): QuotedMessage | null => {
  try {
    const reply = (JSON.parse(str(message.cloudCustomData) || "{}") as Dict).messageReply;
    if (!isDict(reply)) return null;
    const abstract = str(reply.messageAbstract);
    return abstract ? { messageID: str(reply.messageID), sender: str(reply.messageSender), abstract } : null;
  } catch {
    return null;
  }
};

export const quoteData = (quote: QuotedMessage) =>
  ({ messageReply: { messageID: quote.messageID, messageAbstract: quote.abstract, messageSender: quote.sender, messageType: 1, version: 1 } });

export const quoteCustomData = (quote: QuotedMessage): string => JSON.stringify(quoteData(quote));

/**
 * Attachments and the text typed with them travel as separate IM messages that share a bundle id; the text lists
 * the attachment message IDs so readers (and Agents) treat them as one message. Attachment parts have no `parts`.
 */
export const bundleOf = (message: IMMessage): { id: string; parts?: string[] } | null => {
  try {
    const data = JSON.parse(str(message.cloudCustomData) || "{}") as Dict;
    const id = str(data.velaBundle);
    if (!id) return null;
    return Array.isArray(data.velaBundleParts) ? { id, parts: data.velaBundleParts.map(str).filter(Boolean) } : { id };
  } catch {
    return null;
  }
};

/** A centred time line before a message that starts a new day or follows a gap of over five minutes. */
export const timeDivider = (previous: IMMessage | undefined, message: IMMessage, now = Date.now()): string | null => {
  const at = num(message.time);
  if (!at) return null;
  const before = previous ? num(previous.time) : 0;
  const date = new Date(at * 1000);
  if (before && at - before < 300 && new Date(before * 1000).toDateString() === date.toDateString()) return null;
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  if (today.toDateString() === date.toDateString()) return time;
  const yesterday = new Date(now - 86_400_000);
  if (yesterday.toDateString() === date.toDateString()) return `昨天 ${time}`;
  return today.getFullYear() === date.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
};

export const fullTime = (seconds: number): string => (seconds ? new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false }) : "");

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
