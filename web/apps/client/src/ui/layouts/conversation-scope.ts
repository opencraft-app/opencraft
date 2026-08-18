import {
  createComposerDocument,
  isEveryoneChannel,
  selectCurrentHumanMember,
  type Account,
  type ActiveConversation,
  type Channel,
  type ComposerDraft,
  type DirectConversation,
  type Member,
  type Server,
} from "@vela/client-core";

import { memberByImUserId } from "../member-identity";

/**
 * Who you are, where you are, and what you are looking at.
 *
 * The graphical shell worked these out at the top of its render and the page
 * model worked them out again at the top of its build — the same nine
 * questions, five hundred lines apart, answered by two pieces of code that
 * nothing compared. They had already drifted: the model would recognise you by
 * account when IM had not issued a user id yet and the shell would not, and
 * the model excluded you from your own DM candidates by a fallback the shell
 * skipped. The two happened to agree only because the one caller in production
 * omits currentImUserId exactly when the fallback would be empty anyway.
 *
 * One question, one answer, computed once per render and handed to both.
 */

export function conversationDraftKey(
  conversation: ActiveConversation | null,
): string | null {
  if (!conversation) return null;
  return conversation.kind === "channel"
    ? `channel:${conversation.channelId}`
    : `direct:${conversation.peerMemberId}`;
}

export function emptyComposerDraft(): ComposerDraft {
  return { attachments: [], document: createComposerDocument() };
}

export interface ConversationScopeInput {
  account?: Account | null;
  activeConversation?: ActiveConversation | null;
  canManageChannels?: boolean;
  channels: Channel[];
  conversationDrafts?: Record<string, ComposerDraft>;
  currentChannelId: string | null;
  currentImUserId?: string;
  currentServerId: string | null;
  directConversations?: DirectConversation[];
  members?: Member[];
  pendingAction?: string | null;
  servers: Server[];
}

export interface ConversationScope {
  account: Account | null;
  activeConversation: ActiveConversation | null;
  /**
   * A DM you have opened but not yet created still needs a conversation to
   * render into, so an unfound peer gets a provisioning placeholder rather
   * than nothing.
   */
  activeDirectConversation: DirectConversation | undefined;
  activeDirectMember: Member | undefined;
  activeDraft: ComposerDraft;
  activeDraftKey: string | null;
  capabilities: ConversationSurfaceCapabilities;
  canJoinCurrentChannel: boolean;
  currentChannel: Channel | undefined;
  currentMember: Member | undefined;
  currentServer: Server | undefined;
  directCandidates: Member[];
  joiningCurrentChannel: boolean;
  /** The IM identity the viewer is speaking as, if IM has issued one. */
  viewerImUserId: string | undefined;
}

export interface ConversationSurfaceCapabilities {
  mentions: boolean;
  search: boolean;
  tasks: boolean;
  threads: boolean;
}

export function conversationScope(
  input: ConversationScopeInput,
): ConversationScope {
  const account = input.account ?? null;
  const members = input.members ?? [];
  const directConversations = input.directConversations ?? [];
  const viewerImUserId =
    input.currentImUserId ?? account?.imUserId ?? undefined;

  const currentServer = input.servers.find(
    (server) => server.id === input.currentServerId,
  );
  const currentChannel = input.channels.find(
    (channel) => channel.id === input.currentChannelId,
  );
  const activeConversation =
    input.activeConversation ??
    (input.currentChannelId
      ? ({ channelId: input.currentChannelId, kind: "channel" } as const)
      : null);

  // Both identifiers are optional, so an absent one must not match a member
  // that is equally absent — two unknowns are not the same person.
  const currentMember = selectCurrentHumanMember(members, {
    accountId: account?.id,
    imUserId: viewerImUserId ?? account?.imUserId,
  });

  const activeDirectConversation =
    activeConversation?.kind === "direct"
      ? (directConversations.find(
          (item) => item.peerUserId === activeConversation.peerUserId,
        ) ?? {
          conversationId: "",
          directConversationId:
            activeConversation.directConversationId ??
            `draft:${activeConversation.peerMemberId}`,
          imGroupId: "",
          imState: "provisioning" as const,
          lastMessagePreview: "",
          peerDisplayName:
            memberByImUserId(members, activeConversation.peerUserId)
              ?.displayName ?? activeConversation.peerUserId,
          peerMemberId: activeConversation.peerMemberId,
          peerUserId: activeConversation.peerUserId,
          unreadCount: 0,
        })
      : undefined;
  const activeDirectMember = activeDirectConversation
    ? memberByImUserId(members, activeDirectConversation.peerUserId)
    : undefined;

  const activeDraftKey = conversationDraftKey(activeConversation);
  const activeDraft = activeDraftKey
    ? (input.conversationDrafts?.[activeDraftKey] ?? emptyComposerDraft())
    : emptyComposerDraft();
  const capabilities: ConversationSurfaceCapabilities =
    activeConversation === null
      ? {mentions: false, search: false, tasks: false, threads: false}
      : activeConversation.kind === "direct"
        ? {mentions: false, search: true, tasks: false, threads: false}
        : {mentions: true, search: true, tasks: true, threads: true};

  const existingDirectPeers = new Set(
    directConversations.map((item) => item.peerUserId),
  );
  const directCandidates = members.filter(
    (member) =>
      Boolean(member.imUserId) &&
      member.imState === "ready" &&
      member.imUserId !== viewerImUserId &&
      !existingDirectPeers.has(member.imUserId as string),
  );

  const canJoinCurrentChannel = Boolean(
    currentChannel &&
    currentMember &&
    !currentChannel.joined &&
    !isEveryoneChannel(currentChannel) &&
    (currentChannel.visibility === "public" || input.canManageChannels),
  );
  const joiningCurrentChannel = Boolean(
    currentChannel &&
    currentMember &&
    input.pendingAction ===
      `channel:${currentChannel.id}:member:${currentMember.id}:add`,
  );

  return {
    account,
    activeConversation,
    activeDirectConversation,
    activeDirectMember,
    activeDraft,
    activeDraftKey,
    capabilities,
    canJoinCurrentChannel,
    currentChannel,
    currentMember,
    currentServer,
    directCandidates,
    joiningCurrentChannel,
    viewerImUserId,
  };
}
