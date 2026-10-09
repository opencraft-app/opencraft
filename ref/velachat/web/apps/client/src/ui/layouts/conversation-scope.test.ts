import type {
  Account,
  Channel,
  DirectConversation,
  Member,
  Server,
} from "@vela/client-core";

import { conversationDraftKey, conversationScope } from "./conversation-scope";

function member(overrides: Partial<Member> = {}): Member {
  return {
    accountId: null,
    displayName: "林墨",
    id: "member-1",
    imState: "ready",
    imUserId: "im-linmo",
    kind: "human",
    ...overrides,
  } as Member;
}

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    joined: false,
    name: "general",
    systemKey: null,
    visibility: "public",
    ...overrides,
  } as Channel;
}

function directConversation(
  overrides: Partial<DirectConversation> = {},
): DirectConversation {
  return {
    conversationId: "conversation-1",
    directConversationId: "direct-1",
    imGroupId: "group-1",
    imState: "ready",
    lastMessagePreview: "在的",
    peerDisplayName: "林墨",
    peerMemberId: "member-1",
    peerUserId: "im-linmo",
    unreadCount: 0,
    ...overrides,
  } as DirectConversation;
}

const servers: Server[] = [{ id: "server-1", name: "Vela" } as Server];

function input(overrides: Record<string, unknown> = {}) {
  return {
    channels: [channel()],
    currentChannelId: "channel-1",
    currentServerId: "server-1",
    servers,
    ...overrides,
  } as Parameters<typeof conversationScope>[0];
}

describe("conversationScope", () => {
  it("knows you by your account before IM has issued you a name", () => {
    const account = { id: "account-1", imUserId: null } as Account;
    const you = member({ accountId: "account-1", id: "me", imUserId: null });

    const scope = conversationScope(input({ account, members: [you] }));

    expect(scope.currentMember).toBe(you);
    expect(scope.viewerImUserId).toBeUndefined();
  });

  it("refuses to mistake two unknown identities for the same person", () => {
    const stranger = member({
      accountId: null,
      id: "stranger",
      imUserId: null,
    });

    const scope = conversationScope(input({ members: [stranger] }));

    expect(scope.currentMember).toBeUndefined();
  });

  it("keeps you out of your own direct message candidates", () => {
    const account = { id: "account-1", imUserId: "im-me" } as Account;
    const you = member({ accountId: "account-1", id: "me", imUserId: "im-me" });
    const peer = member({ id: "peer", imUserId: "im-peer" });

    // The caller omits currentImUserId; the account still names the viewer.
    const scope = conversationScope(input({ account, members: [you, peer] }));

    expect(scope.directCandidates.map((item) => item.id)).toEqual(["peer"]);
  });

  it("leaves out peers you already have a conversation with", () => {
    const peer = member({ id: "peer", imUserId: "im-peer" });
    const other = member({ id: "other", imUserId: "im-other" });

    const scope = conversationScope(
      input({
        directConversations: [directConversation({ peerUserId: "im-peer" })],
        members: [peer, other],
      }),
    );

    expect(scope.directCandidates.map((item) => item.id)).toEqual(["other"]);
  });

  it("leaves out peers IM has not finished provisioning", () => {
    const pending = member({ id: "pending", imState: "provisioning" });

    const scope = conversationScope(input({ members: [pending] }));

    expect(scope.directCandidates).toEqual([]);
  });

  it("gives an unopened direct message somewhere to render", () => {
    const peer = member({ id: "peer", imUserId: "im-peer" });

    const scope = conversationScope(
      input({
        activeConversation: {
          kind: "direct",
          peerMemberId: "peer",
          peerUserId: "im-peer",
        },
        members: [peer],
      }),
    );

    expect(scope.activeDirectConversation).toMatchObject({
      directConversationId: "draft:peer",
      imState: "provisioning",
      peerDisplayName: "林墨",
    });
    expect(scope.activeDirectMember).toBe(peer);
  });

  it("prefers the conversation you already have over a placeholder", () => {
    const existing = directConversation();

    const scope = conversationScope(
      input({
        activeConversation: {
          kind: "direct",
          peerMemberId: "member-1",
          peerUserId: "im-linmo",
        },
        directConversations: [existing],
        members: [member()],
      }),
    );

    expect(scope.activeDirectConversation).toBe(existing);
  });

  it("offers to join a public channel you are not in", () => {
    const account = { id: "account-1", imUserId: "im-me" } as Account;
    const you = member({ accountId: "account-1", id: "me", imUserId: "im-me" });

    const scope = conversationScope(input({ account, members: [you] }));

    expect(scope.canJoinCurrentChannel).toBe(true);
  });

  it("withholds the join offer from a private channel you cannot manage", () => {
    const account = { id: "account-1", imUserId: "im-me" } as Account;
    const you = member({ accountId: "account-1", id: "me", imUserId: "im-me" });

    const scope = conversationScope(
      input({
        account,
        channels: [channel({ visibility: "private" })],
        members: [you],
      }),
    );

    expect(scope.canJoinCurrentChannel).toBe(false);
    expect(
      conversationScope(
        input({
          account,
          canManageChannels: true,
          channels: [channel({ visibility: "private" })],
          members: [you],
        }),
      ).canJoinCurrentChannel,
    ).toBe(true);
  });

  it("withholds the join offer when there is nobody to join as", () => {
    const scope = conversationScope(input({ members: [] }));

    expect(scope.canJoinCurrentChannel).toBe(false);
  });

  it("reads the pending join off the action it would have started", () => {
    const account = { id: "account-1", imUserId: "im-me" } as Account;
    const you = member({ accountId: "account-1", id: "me", imUserId: "im-me" });

    const scope = conversationScope(
      input({
        account,
        members: [you],
        pendingAction: "channel:channel-1:member:me:add",
      }),
    );

    expect(scope.joiningCurrentChannel).toBe(true);
  });

  it("falls back to the open channel when no conversation is named", () => {
    const scope = conversationScope(input());

    expect(scope.activeConversation).toEqual({
      channelId: "channel-1",
      kind: "channel",
    });
  });

  it("hands back an empty draft rather than nothing", () => {
    const scope = conversationScope(input());

    expect(scope.activeDraftKey).toBe("channel:channel-1");
    expect(scope.activeDraft.attachments).toEqual([]);
  });
});

describe("conversationDraftKey", () => {
  it("keys a channel draft by channel and a direct draft by member", () => {
    expect(
      conversationDraftKey({ channelId: "channel-1", kind: "channel" }),
    ).toBe("channel:channel-1");
    expect(
      conversationDraftKey({
        kind: "direct",
        peerMemberId: "member-1",
        peerUserId: "im-linmo",
      }),
    ).toBe("direct:member-1");
    expect(conversationDraftKey(null)).toBeNull();
  });
});
