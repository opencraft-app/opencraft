import type {
  Channel,
  ComposerDraft,
  ConversationSummary,
  DirectConversation,
  Member,
} from "@vela/client-core";
import { channelAddress, composerDocumentPreview } from "@vela/client-core";

import { memberByImUserId, memberIdentityLabel } from "../member-identity";

/**
 * What the conversation directory shows, and what each row says.
 *
 * The sidebar on a pointer and the picker under a finger are two shapes — one
 * a standing pane of icon-sized controls, the other a full-height sheet with a
 * server switcher on top — and they should stay two shapes. What they are not
 * is two answers. They each used to derive their own filtered lists and spell
 * out their own row copy, so a channel could read "私密频道 · 尚未加入" on the
 * desktop and something else on a phone the moment either copy was touched,
 * and searching by member kind worked in one and not the other.
 *
 * The shapes live in the components. The answers live here.
 */

export function composerDraftPreview(draft: ComposerDraft | undefined): string {
  if (!draft) return "";
  const text = composerDocumentPreview(draft.document);
  if (text) return text;
  return draft.attachments.length > 0
    ? `[${draft.attachments.length} 个附件]`
    : "";
}

export function channelConversationSummary(
  channel: Channel,
  summaries: ConversationSummary[],
): ConversationSummary | undefined {
  const conversationId = channelAddress(channel)?.conversationId;
  if (!conversationId) return undefined;
  return summaries.find((summary) => summary.conversationId === conversationId);
}

export function channelDraftPreview(
  channel: Channel,
  drafts: Record<string, ComposerDraft>,
): string {
  return composerDraftPreview(drafts[`channel:${channel.id}`]);
}

export function directDraftPreview(
  conversation: DirectConversation,
  drafts: Record<string, ComposerDraft>,
): string {
  return composerDraftPreview(drafts[`direct:${conversation.peerMemberId}`]);
}

export function directIdentitySummary(
  member: Member | undefined,
): string | null {
  if (!member) return null;
  const actor = member.kind === "agent" ? "Agent" : "自然人";
  const handle = memberIdentityLabel(member);
  return handle ? `${actor} · ${handle}` : actor;
}

/**
 * How an unsent draft announces itself. The compact DM row shows this alone
 * and no preview beneath it — that row is one line shorter by design — but the
 * marker itself should read the same wherever it appears.
 */
export function draftLabel(draftPreview: string): string | null {
  return draftPreview ? `[草稿] ${draftPreview}` : null;
}

/** A count wide enough to overrun its badge is reported as "99+". */
export function unreadLabel(count: number | undefined): string | null {
  if (!count || count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

/** The one line under a channel's name, whichever shape is drawing it. */
export function channelRowPreview(
  channel: Channel,
  summary: ConversationSummary | undefined,
  draftPreview: string,
): string {
  const draft = draftLabel(draftPreview);
  if (draft) return draft;
  if (!channel.joined) {
    return channel.visibility === "public"
      ? "公开频道 · 可加入"
      : "私密频道 · 尚未加入";
  }
  return (
    summary?.lastMessagePreview ||
    channel.description ||
    (channel.systemKey === "all" ? "全体成员根群" : "Human 与 Agent 的日常协作")
  );
}

/** The one line under a peer's name, whichever shape is drawing it. */
export function directRowPreview(
  conversation: DirectConversation,
  draftPreview: string,
): string {
  return (
    draftLabel(draftPreview) || conversation.lastMessagePreview || "开始私信"
  );
}

export interface ConversationDirectoryInput {
  channels: Channel[];
  conversationDrafts: Record<string, ComposerDraft>;
  conversationSummaries: ConversationSummary[];
  directCandidates: Member[];
  directConversations: DirectConversation[];
  filter: string;
  members: Member[];
}

export interface ConversationDirectory {
  channels: Channel[];
  directConversations: DirectConversation[];
  /** Members surface only as search results; an unfiltered directory has none. */
  members: Member[];
  matched: boolean;
  searching: boolean;
}

export function conversationDirectory({
  channels,
  conversationDrafts,
  conversationSummaries,
  directCandidates,
  directConversations,
  filter,
  members,
}: ConversationDirectoryInput): ConversationDirectory {
  const needle = filter.trim().toLocaleLowerCase();
  const hit = (values: Array<string | null | undefined>) =>
    values.some((value) => (value ?? "").toLocaleLowerCase().includes(needle));

  if (!needle) {
    return {
      channels,
      directConversations,
      matched: true,
      members: [],
      searching: false,
    };
  }

  const visibleChannels = channels.filter((channel) =>
    hit([
      channel.name,
      channel.description,
      channelConversationSummary(channel, conversationSummaries)
        ?.lastMessagePreview,
      channelDraftPreview(channel, conversationDrafts),
    ]),
  );
  const visibleDirectConversations = directConversations.filter(
    (conversation) =>
      hit([
        conversation.peerDisplayName,
        memberIdentityLabel(memberByImUserId(members, conversation.peerUserId)),
        conversation.lastMessagePreview,
        directDraftPreview(conversation, conversationDrafts),
      ]),
  );
  const visibleMembers = directCandidates.filter((member) =>
    hit([member.displayName, member.handle, member.kind]),
  );

  return {
    channels: visibleChannels,
    directConversations: visibleDirectConversations,
    matched:
      visibleChannels.length > 0 ||
      visibleDirectConversations.length > 0 ||
      visibleMembers.length > 0,
    members: visibleMembers,
    searching: true,
  };
}
