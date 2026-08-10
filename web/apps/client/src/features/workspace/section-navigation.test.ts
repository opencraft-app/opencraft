import {
  activeConversationMatches,
  authRouteHref,
  canonicalRouteSearch,
  canonicalizeServerPathname,
  computerHref,
  defaultSignedInHref,
  directConversationHref,
  firstRoutableChannelId,
  newDirectConversationHref,
  resolveServerRouteReference,
  routeParam,
  safeReturnTo,
  serverRootHref,
  withCanonicalRouteSearch,
  workspaceActiveSectionFromPathname,
  workspaceSectionHref,
} from "./section-navigation";

const atlas = {
  id: "019fb723-68b8-79ac-b31e-9d0a657c43ec",
  imState: "ready" as const,
  name: "Atlas",
  ownerMemberId: "member-1",
  revision: 1,
  slug: "atlas",
};

describe("workspaceSectionHref", () => {
  it("maps each section to its canonical Server route", () => {
    expect(
      workspaceSectionHref("server 1", "chat", "channel/1"),
    ).toBe("/s/server%201/c/channel%2F1");
    expect(workspaceSectionHref("server 1", "tasks")).toBe(
      "/s/server%201/tasks",
    );
    expect(workspaceSectionHref("server 1", "agents")).toBe(
      "/s/server%201/agents",
    );
    expect(workspaceSectionHref("server 1", "computers")).toBe(
      "/s/server%201/computers",
    );
    expect(workspaceSectionHref("server 1", "members")).toBe(
      "/s/server%201/members",
    );
    expect(workspaceSectionHref("server 1", "settings")).toBe(
      "/s/server%201/settings",
    );
    expect(computerHref("server 1", "computer/1")).toBe(
      "/s/server%201/computers/computer%2F1",
    );
  });

  it("uses the fixed Server root when chat has no Channel", () => {
    expect(workspaceSectionHref("atlas", "chat", null)).toBe(
      "/s/atlas",
    );
    expect(serverRootHref("server 1")).toBe("/s/server%201");
  });
});

describe("workspaceActiveSectionFromPathname", () => {
  it("maps chat and management paths to the shared chrome section", () => {
    expect(workspaceActiveSectionFromPathname("/s/atlas")).toBe("chat");
    expect(workspaceActiveSectionFromPathname("/s/atlas/c/channel-1")).toBe(
      "chat",
    );
    expect(workspaceActiveSectionFromPathname("/s/atlas/dm/dc-1")).toBe(
      "chat",
    );
    expect(workspaceActiveSectionFromPathname("/s/atlas/dm/new")).toBe(
      "chat",
    );
    expect(workspaceActiveSectionFromPathname("/s/atlas/tasks")).toBe(
      "tasks",
    );
    expect(workspaceActiveSectionFromPathname("/s/atlas/agents")).toBe(
      "agents",
    );
    expect(workspaceActiveSectionFromPathname("/s/atlas/computers")).toBe(
      "computers",
    );
    expect(
      workspaceActiveSectionFromPathname("/s/atlas/computers/computer-1"),
    ).toBe("computers");
    expect(workspaceActiveSectionFromPathname("/s/atlas/members")).toBe(
      "members",
    );
    expect(workspaceActiveSectionFromPathname("/s/atlas/settings")).toBe(
      "settings",
    );
  });
});

describe("canonicalizeServerPathname", () => {
  it("rewrites a legacy Server id while keeping the rest of the route", () => {
    expect(
      canonicalizeServerPathname(
        `/s/${atlas.id}/computers/computer-1`,
        atlas.id,
        "atlas",
      ),
    ).toBe("/s/atlas/computers/computer-1");
    expect(
      canonicalizeServerPathname(
        `/s/${atlas.id}/dm/new`,
        atlas.id,
        "atlas",
        "?peerMemberId=member-2",
      ),
    ).toBe("/s/atlas/dm/new?peerMemberId=member-2");
  });
});

describe("resolveServerRouteReference", () => {
  it("resolves visible Server refs while canonicalizing legacy IDs", () => {
    expect(resolveServerRouteReference([atlas], "atlas")).toEqual({
      canonicalSlug: "atlas",
      legacyReference: false,
      server: atlas,
      status: "ready",
    });
    expect(
      resolveServerRouteReference([atlas], atlas.id),
    ).toEqual({
      canonicalSlug: "atlas",
      legacyReference: true,
      server: atlas,
      status: "ready",
    });
    expect(
      resolveServerRouteReference([atlas], "hidden"),
    ).toEqual({status: "unavailable"});
  });

  it("rejects an ID/slug cross-match instead of choosing ambiguously", () => {
    const collision = {
      ...atlas,
      id: "server-2",
      slug: atlas.id,
    };
    expect(
      resolveServerRouteReference([atlas, collision], atlas.id),
    ).toEqual({status: "unavailable"});
  });
});

describe("firstRoutableChannelId", () => {
  it("chooses the ready all-members system Topic before an ordinary Channel", () => {
    const systemChannel = {
      id: "channel-all",
      joined: true,
      imGroupId: "community-1",
      imState: "ready" as const,
      imTopicId: "topic-all",
      name: "全员",
      revision: 1,
      serverId: atlas.id,
      systemKey: "all" as const,
      visibility: "public" as const,
    };
    const topicChannel = {
      ...systemChannel,
      id: "channel-general",
      imTopicId: "topic-general",
      name: "闲聊",
      systemKey: null,
    };

    expect(firstRoutableChannelId([topicChannel, systemChannel])).toBe(
      systemChannel.id,
    );
    expect(firstRoutableChannelId([systemChannel])).toBe(
      systemChannel.id,
    );
    expect(
      firstRoutableChannelId([
        {...topicChannel, imState: "provisioning" as const},
      ]),
    ).toBeNull();
  });
});

describe("browser route safety", () => {
  it("preserves only the local backend override", () => {
    expect(
      canonicalRouteSearch(
        "?backend=http%3A%2F%2F127.0.0.1%3A18081&thread=secret",
        "localhost",
      ),
    ).toBe("?backend=http%3A%2F%2F127.0.0.1%3A18081");
    expect(
      canonicalRouteSearch(
        "?backend=http%3A%2F%2F127.0.0.1%3A18081",
        "app.example.com",
      ),
    ).toBe("");
    expect(
      withCanonicalRouteSearch(
        "/s/atlas/tasks",
        "?backend=http%3A%2F%2F127.0.0.1%3A18081&token=secret",
        "127.0.0.1",
      ),
    ).toBe(
      "/s/atlas/tasks?backend=http%3A%2F%2F127.0.0.1%3A18081",
    );
  });

  it("preserves route-owned query parameters while canonicalizing backend", () => {
    expect(
      withCanonicalRouteSearch(
        "/s/tencent/dm/new?peerMemberId=member-agent-1&backend=https%3A%2F%2Fevil.example",
        "?backend=http%3A%2F%2F127.0.0.1%3A18081",
        "localhost",
      ),
    ).toBe(
      "/s/tencent/dm/new?peerMemberId=member-agent-1&backend=http%3A%2F%2F127.0.0.1%3A18081",
    );
  });

  it("accepts only known internal return paths", () => {
    expect(safeReturnTo("/join", "app.example.com")).toBe("/join");
    expect(safeReturnTo("/s/atlas/c/channel-1", "app.example.com")).toBe(
      "/s/atlas/c/channel-1",
    );
    expect(safeReturnTo("/s/atlas/computers/computer-1")).toBe(
      "/s/atlas/computers/computer-1",
    );
    expect(
      safeReturnTo(
        "/s/atlas?backend=http%3A%2F%2F127.0.0.1%3A18081&x=1",
        "localhost",
      ),
    ).toBe(
      "/s/atlas?backend=http%3A%2F%2F127.0.0.1%3A18081",
    );
  });

  it("keeps peerMemberId on new-DM return paths through auth", () => {
    expect(
      safeReturnTo(
        "/s/atlas/dm/new?peerMemberId=member-agent-1&token=secret",
        "app.example.com",
      ),
    ).toBe("/s/atlas/dm/new?peerMemberId=member-agent-1");
    expect(
      safeReturnTo(
        "/s/atlas/dm/new?peerMemberId=member%2Fagent+1&backend=http%3A%2F%2F127.0.0.1%3A18081",
        "localhost",
      ),
    ).toBe(
      "/s/atlas/dm/new?peerMemberId=member%2Fagent+1&backend=http%3A%2F%2F127.0.0.1%3A18081",
    );
    expect(
      authRouteHref(
        "login",
        "/s/atlas/dm/new?peerMemberId=member-agent-1",
        "app.example.com",
      ),
    ).toBe(
      "/login?returnTo=%2Fs%2Fatlas%2Fdm%2Fnew%3FpeerMemberId%3Dmember-agent-1",
    );
  });

  it("coalesces Expo string | string[] route params", () => {
    expect(routeParam("channel-1")).toBe("channel-1");
    expect(routeParam(["channel-1", "channel-2"])).toBe("channel-1");
    expect(routeParam(undefined, "")).toBe("");
  });

  it.each([
    "https://evil.example/s/atlas",
    "//evil.example/s/atlas",
    "/login",
    "/register",
    "/unknown",
    "/s/%ZZ",
    "/s/atlas/c/channel%2Fescape",
    "/s/atlas\\tasks",
  ])("falls back to root for unsafe returnTo %s", (value) => {
    expect(safeReturnTo(value, "localhost")).toBe("/");
  });

  it("carries a safe return target between authentication routes", () => {
    expect(
      authRouteHref(
        "login",
        "/s/atlas/c/channel-1?backend=http%3A%2F%2F127.0.0.1%3A18081",
        "localhost",
      ),
    ).toBe(
      "/login?returnTo=%2Fs%2Fatlas%2Fc%2Fchannel-1%3Fbackend%3Dhttp%253A%252F%252F127.0.0.1%253A18081",
    );
    expect(
      authRouteHref("register", "https://evil.example", "localhost"),
    ).toBe("/register");
  });
});

describe("directConversationHref", () => {
  it("keeps a DM inside the Server that opened it", () => {
    expect(directConversationHref("agent/im 1", "atlas cn")).toBe(
      "/s/atlas%20cn/dm/agent%2Fim%201",
    );
    expect(safeReturnTo("/s/atlas/dm/agent-1")).toBe(
      "/s/atlas/dm/agent-1",
    );
  });

  it("keeps a new DM draft inside its Server until first send", () => {
    expect(newDirectConversationHref("member/agent 1", "atlas cn")).toBe(
      "/s/atlas%20cn/dm/new?peerMemberId=member%2Fagent+1",
    );
  });

  it("prefers a Channel before onboarding", () => {
    expect(
      defaultSignedInHref({
        currentChannelId: "channel-1",
        currentServerId: "server-1",
      }),
    ).toBe("/s/server-1/c/channel-1");
    expect(
      defaultSignedInHref({
        currentChannelId: null,
        currentServerId: null,
      }),
    ).toBe("/home");
  });

  it("matches a route target only to the same active conversation", () => {
    expect(
      activeConversationMatches(
        {directConversationId: "direct-1", kind: "direct", peerMemberId: "member-agent-1", peerUserId: "agent-1"},
        {directConversationId: "direct-1", kind: "direct"},
      ),
    ).toBe(true);
    expect(
      activeConversationMatches(
        {channelId: "channel-1", kind: "channel"},
        {directConversationId: "direct-1", kind: "direct"},
      ),
    ).toBe(false);
  });
});
