import type {
  Channel,
  ConversationSummary,
  DirectConversation,
  Member,
} from "@vela/client-core";

import {
  channelDirectoryRow,
  channelRowPreview,
  conversationDirectory,
  directDirectoryRow,
  directRowPreview,
  unreadLabel,
} from "./conversation-directory";

const channel: Channel = {
  id: "channel-1",
  imGroupId: "community-1",
  imState: "ready",
  imTopicId: "topic-1",
  joined: true,
  name: "general",
  revision: 1,
  serverId: "server-1",
  visibility: "public",
};

const directConversation: DirectConversation = {
  conversationId: "conversation-1",
  directConversationId: "direct-1",
  imGroupId: "group-1",
  imState: "ready",
  lastMessagePreview: "昨天的结论我整理好了",
  peerDisplayName: "周岚",
  peerMemberId: "member-2",
  peerUserId: "user-2",
  unreadCount: 0,
};

const member = {
  displayName: "周岚",
  handle: "zhoulan",
  id: "member-2",
  imUserId: "user-2",
  kind: "human",
  role: "member",
  serverId: "server-1",
} as unknown as Member;

function directory(filter: string, overrides: Partial<Member> = {}) {
  return conversationDirectory({
    channels: [channel],
    conversationDrafts: {},
    conversationSummaries: [],
    directCandidates: [{ ...member, ...overrides }],
    directConversations: [directConversation],
    filter,
    members: [{ ...member, ...overrides }],
  });
}

describe("conversation directory", () => {
  it("shows the whole directory until someone searches", () => {
    // Members are search results, not a standing section: an unfiltered
    // directory lists channels and DMs and nothing else.
    const all = directory("");

    expect(all.searching).toBe(false);
    expect(all.channels).toHaveLength(1);
    expect(all.directConversations).toHaveLength(1);
    expect(all.members).toEqual([]);
    expect(all.matched).toBe(true);
  });

  it("treats a filter of nothing but spaces as no filter at all", () => {
    expect(directory("   ").searching).toBe(false);
  });

  it("reads a member's kind as searchable, on a pointer as on a phone", () => {
    // The sidebar searched display name and handle; the compact picker
    // searched display name, handle and kind. Same box, same placeholder, two
    // answers — and only the phone could find an Agent by typing "agent".
    expect(directory("agent", { kind: "agent" }).members).toHaveLength(1);
  });

  it("reports no match only when nothing anywhere matched", () => {
    expect(directory("general").matched).toBe(true);
    expect(directory("周岚").matched).toBe(true);
    expect(directory("zhoulan").matched).toBe(true);
    expect(directory("没有这个东西").matched).toBe(false);
  });

  it("says the same thing under a channel's name in either shape", () => {
    // This copy sat inline in the sidebar and again inline in the compact
    // picker. Nothing compared them, so either could have been reworded alone.
    const summary = {
      lastMessagePreview: "最新一条",
    } as ConversationSummary;

    expect(channelRowPreview(channel, summary, "写了一半")).toBe(
      "[草稿] 写了一半",
    );
    expect(
      channelRowPreview({ ...channel, joined: false }, undefined, ""),
    ).toBe("公开频道 · 可加入");
    expect(
      channelRowPreview(
        { ...channel, joined: false, visibility: "private" },
        undefined,
        "",
      ),
    ).toBe("私密频道 · 尚未加入");
    expect(channelRowPreview(channel, summary, "")).toBe("最新一条");
    expect(
      channelRowPreview({ ...channel, description: "设计评审" }, undefined, ""),
    ).toBe("设计评审");
    expect(channelRowPreview({ ...channel, systemKey: "all" }, undefined, "")).toBe(
      "全体成员根群",
    );
    expect(channelRowPreview(channel, undefined, "")).toBe(
      "Human 与 Agent 的日常协作",
    );
  });

  it("says the same thing under a peer's name in either shape", () => {
    expect(directRowPreview(directConversation, "还没发出去")).toBe(
      "[草稿] 还没发出去",
    );
    expect(directRowPreview(directConversation, "")).toBe("昨天的结论我整理好了");
    expect(
      directRowPreview({ ...directConversation, lastMessagePreview: "" }, ""),
    ).toBe("开始私信");
  });

  it("caps an unread count where the badge runs out of room", () => {
    expect(unreadLabel(0)).toBeNull();
    expect(unreadLabel(undefined)).toBeNull();
    expect(unreadLabel(7)).toBe("7");
    expect(unreadLabel(99)).toBe("99");
    expect(unreadLabel(100)).toBe("99+");
  });

  it("assembles a channel row once for both shapes", () => {
    const row = channelDirectoryRow(channel, {
      channelHref: (item) => `/c/${item.id}`,
      conversationDrafts: {},
      conversationSummaries: [
        {
          conversationId: "GROUPtopic-1",
          lastMessageAt: "2026-08-02T02:31:00.000Z",
          lastMessagePreview: "最新一条",
          unreadCount: 4,
        } as ConversationSummary,
      ],
      currentChannelId: "channel-1",
    });

    expect(row).toMatchObject({
      accessibilityLabel: "打开 Channel general",
      href: "/c/channel-1",
      preview: "最新一条",
      selected: true,
      unread: "4",
    });
    expect(row.lastMessageTime.length).toBeGreaterThan(0);
  });

  it("names a direct peer's kind so both shapes paint the same mark", () => {
    // The desktop row used to draw every peer as a neutral monogram; the
    // compact row had no mark at all. Neither asked the member list whether
    // the peer was an Agent. The row answer now carries the kind.
    const agent = {
      ...member,
      displayName: "Atlas",
      handle: "atlas",
      kind: "agent",
    } as unknown as Member;

    expect(
      directDirectoryRow(
        {
          ...directConversation,
          peerDisplayName: "Atlas",
          peerUserId: "user-2",
          unreadCount: 12,
        },
        {
          activeConversation: {
            kind: "direct",
            peerMemberId: "member-2",
            peerUserId: "user-2",
          },
          conversationDrafts: {},
          members: [agent],
        },
      ),
    ).toMatchObject({
      accessibilityLabel: "打开私信 Atlas @atlas",
      identityKind: "agent",
      monogram: "A",
      selected: true,
      unread: "12",
    });
  });
});
