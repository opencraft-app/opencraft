import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ExtensionSupervisor,
  type InternalContributionAdapter,
} from "@opencraft/extension-runtime";
import { createLightVelaCollaborationExtension } from "../plugins/lightvela-collaboration/src/extension";
import { CollaborationClient } from "../plugins/lightvela-collaboration/src/collaboration-client";
import { createCollaborationWorkspaceView } from "../plugins/lightvela-collaboration/src/collaboration-workspace-view";
import { CollaborationWorkspaceController } from "../plugins/lightvela-collaboration/src/collaboration-workspace-controller";
import { CollaborationWorkspaceService } from "../plugins/lightvela-collaboration/src/collaboration-workspace-service";
import { ImChatService } from "../plugins/lightvela-collaboration/src/im-chat-service";
import { ImDirectoryService } from "../plugins/lightvela-collaboration/src/im-directory-service";

test("empty Collaboration Workspace offers Server creation instead of a dead end", async () => {
  const previousReact = (globalThis as { React?: typeof React }).React;
  (globalThis as { React?: typeof React }).React = React;
  try {
  let connectionFailure: Error | null = null;
  const client = {
    getMe: async () => ({ id: "account-1", displayName: "Ada", email: "", imState: "ready", revision: 1 }),
    listServers: async () => ({ items: [], nextCursor: null }),
    getServer: async () => { throw new Error("not used"); },
    createServer: async () => { throw new Error("not used"); },
    listComputersV2: async () => [],
    attachComputerV2: async () => { throw new Error("not used"); },
    listChannels: async () => [],
    listMembers: async () => [],
    listDirectConversations: async () => [],
    createDirectConversation: async () => { throw new Error("not used"); },
  };
  const messaging = {
    connect: async () => {
      if (connectionFailure) throw connectionFailure;
    },
    dispose: async () => {},
    setScope: async () => {},
    subscribeMessages: () => () => {},
    loadHistory: async () => ({ messages: [], completed: true }),
    markRead: async () => {},
    sendText: async () => { throw new Error("not used"); },
    waitUntilReady: async () => {},
  };
  const workspace = new CollaborationWorkspaceService(client as never, messaging, { listInstances: async () => [] });
  const directory = new ImDirectoryService(client as never, messaging);
  const chat = new ImChatService(messaging as never);
  const controller = new CollaborationWorkspaceController(workspace, directory, chat);
  const View = createCollaborationWorkspaceView({
    workspace, directory, chat, controller, computersEnabled: false,
  });
  await workspace.load();

  const viewProps = {
    activation: { viewId: "lightvela.collaboration.workspace-view", resourceUri: "lightvela-collaboration://home" },
    contribution: { id: "lightvela.collaboration.workspace-view", title: "Collaboration", viewType: "lightvela.collaboration.workspace" },
    host: { pushViewResource() {}, replaceViewResource() {} },
  };
  const markup = renderToStaticMarkup(React.createElement(View, viewProps as never));

  assert.match(markup, /创建 Server/);
  assert.match(markup, /Server 名称/);
  assert.match(markup, /加入已有 Server/);
  assert.match(markup, /邀请令牌/);
  assert.match(markup, /<form/);
  connectionFailure = new Error("private transport detail");
  await workspace.load();
  const failedMarkup = renderToStaticMarkup(React.createElement(View, viewProps as never));
  assert.match(failedMarkup, /重试/);
  assert.doesNotMatch(failedMarkup, /private transport detail/);
  connectionFailure = Object.assign(new Error("Please sign in to LightVela"), { status: 401 });
  await workspace.load();
  const signedOutMarkup = renderToStaticMarkup(React.createElement(View, viewProps as never));
  assert.equal(workspace.getSnapshot().errorKind, "authentication");
  assert.match(signedOutMarkup, /登录后/);
  chat.dispose();
  await workspace.dispose();
  } finally {
    (globalThis as { React?: typeof React }).React = previousReact;
  }
});

test("uncertain IM delivery offers confirmation without a second send", () => {
  const previousReact = (globalThis as { React?: typeof React }).React;
  (globalThis as { React?: typeof React }).React = React;
  try {
    const serverId = "server-1";
    const channel = {
      id: "channel-1", serverId, name: "general", visibility: "public",
      joined: true, systemKey: "all", imGroupId: "community-1",
      imTopicId: "topic-1", imState: "ready", revision: 1,
    };
    const snapshot = <T,>(value: T) => ({
      getSnapshot: () => value,
      subscribe: () => () => {},
    });
    const View = createCollaborationWorkspaceView({
      workspace: snapshot({
        phase: "ready", account: { id: "account-1", imUserId: "human-1" },
        servers: [{ id: serverId, slug: "general", name: "General", ownerMemberId: "member-1", imState: "ready", revision: 1 }],
        availableInstances: [], computersByServer: {}, error: null, errorKind: null, revision: 1,
      }) as never,
      directory: snapshot({
        phase: "ready", serverId, channels: [channel], directConversations: [],
        members: [{ id: "member-1", accountId: "account-1", imUserId: "human-1", role: "owner", kind: "human", displayName: "Ada" }],
        error: null, revision: 1,
      }) as never,
      chat: snapshot({
        phase: "error", address: {
          channelId: channel.id, conversationId: "GROUPtopic-1",
          imGroupId: channel.imGroupId, imTopicId: channel.imTopicId, targetId: channel.imTopicId,
        },
        messages: [], draft: "", historyCompleted: true, historyCursor: null,
        historyLoading: false, sendResolution: "uncertain", error: "ack lost", revision: 1,
      }) as never,
      controller: { activate: async () => {} } as never,
      computersEnabled: false,
    });
    const markup = renderToStaticMarkup(React.createElement(View, {
      activation: {
        viewId: "lightvela.collaboration.workspace-view",
        resourceUri: "lightvela-collaboration://servers/server-1/chat/channels/channel-1",
      },
      contribution: { id: "lightvela.collaboration.workspace-view", title: "Collaboration", viewType: "lightvela.collaboration.workspace" },
      host: { pushViewResource() {}, replaceViewResource() {} },
    } as never));
    assert.match(markup, /发送结果待确认/);
    assert.match(markup, /生成一次性邀请/);
    assert.match(markup, /<button type="submit">确认状态<\/button>/);
  } finally {
    (globalThis as { React?: typeof React }).React = previousReact;
  }
});

test("failed root Channel initialization is not shown as endless preparation", () => {
  const previousReact = (globalThis as { React?: typeof React }).React;
  (globalThis as { React?: typeof React }).React = React;
  try {
    const snapshot = <T,>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} });
    const View = createCollaborationWorkspaceView({
      workspace: snapshot({
        phase: "ready", account: { id: "account-1" },
        servers: [{ id: "server-1", name: "Builders", imState: "ready" }],
        availableInstances: [], computersByServer: {}, error: null,
      }) as never,
      directory: snapshot({
        phase: "ready", serverId: "server-1",
        channels: [{ id: "channel-1", name: "全员", joined: true, imState: "error", systemKey: "all" }],
        directConversations: [], members: [], error: null,
      }) as never,
      chat: snapshot({ phase: "idle", address: null, messages: [], draft: "" }) as never,
      controller: { activate: async () => {} } as never,
      computersEnabled: false,
    });
    const markup = renderToStaticMarkup(React.createElement(View, {
      activation: { viewId: "lightvela.collaboration.workspace-view", resourceUri: "lightvela-collaboration://servers/server-1/chat" },
      host: { pushViewResource() {}, replaceViewResource() {} },
    } as never));
    assert.match(markup, /聊天初始化失败/);
    assert.doesNotMatch(markup, /正在准备聊天/);
  } finally {
    (globalThis as { React?: typeof React }).React = previousReact;
  }
});

test("LightVela collaboration contributes one routed Workspace without owning Agents", async () => {
  const renderers = new Map<string, { readonly viewType: string; readonly Component: unknown }>();
  const rendererAdapter: InternalContributionAdapter = {
    prepare(_owner, value) {
      const contribution = value as { readonly viewType: string; readonly Component: unknown };
      return {
        commit: () => {
          renderers.set(contribution.viewType, contribution);
          return () => { renderers.delete(contribution.viewType); };
        },
      };
    },
  };
  let authGeneration = 0;
  let accountDisposals = 0;
  const authorityListeners = new Set<() => void>();
  let messageSubscriptions = 0;
  let messagingCloses = 0;
  let signalFirstClose!: () => void;
  const firstClose = new Promise<void>((resolve) => { signalFirstClose = resolve; });
  const messaging = {
    subscribeMessages: () => {
      messageSubscriptions += 1;
      return () => { messageSubscriptions -= 1; };
    },
    close: async () => { messagingCloses += 1; signalFirstClose(); },
  };
  const account = {
    getSnapshot: () => ({ authGeneration }),
    subscribe: (listener: () => void) => {
      authorityListeners.add(listener);
      return () => { authorityListeners.delete(listener); };
    },
    dispose: () => { accountDisposals += 1; },
    async listInstances() { return []; },
    async requestRaw<T>(): Promise<T> {
      return { items: [], nextCursor: null } as T;
    },
  };
  const supervisor = new ExtensionSupervisor({
    platform: "web",
    internalContributions: { platformViewRenderer: rendererAdapter },
  });

  await supervisor.activate({
    manifest: {
      manifestVersion: 1,
      id: "lightvela.platform",
      name: "LightVela Platform Test Stub",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web"],
      activationEvents: ["onStartupFinished"],
    },
    activate() {},
  });
  await supervisor.activate(createLightVelaCollaborationExtension({ account, messaging: messaging as never }));

  const snapshot = supervisor.contributions.getSnapshot();
  assert.deepEqual(
    snapshot.views.map(({ contribution }) => contribution),
    [{
      id: "lightvela.collaboration.workspace-view",
      title: "Collaboration",
      viewType: "lightvela.collaboration.workspace",
      icon: "message-circle",
      platforms: ["web"],
    }],
  );
  assert.deepEqual(
    snapshot.navigation.map(({ contribution }) => contribution),
    [{
      id: "lightvela.collaboration.workspace",
      title: "Collaboration",
      surface: "sidebar-primary",
      target: { kind: "view", viewId: "lightvela.collaboration.workspace-view" },
      order: 200,
      icon: "message-circle",
      platforms: ["web"],
    }],
  );
  assert.deepEqual(snapshot.bots, []);
  assert.deepEqual([...renderers.keys()], [
    "lightvela.collaboration.workspace",
  ]);
  assert.equal(typeof renderers.get("lightvela.collaboration.workspace")?.Component, "function");

  authGeneration = 1;
  authorityListeners.forEach((listener) => listener());
  await firstClose;
  assert.equal(messagingCloses, 1);
  assert.equal(messageSubscriptions, 1);
  assert.equal(await supervisor.deactivate("lightvela.collaboration"), true);
  assert.equal(messagingCloses, 2);
  assert.equal(messageSubscriptions, 0);
  assert.equal(authorityListeners.size, 0);
  assert.equal(accountDisposals, 0);
  assert.equal(renderers.size, 0);
  assert.deepEqual(supervisor.contributions.getSnapshot().views, []);
  assert.deepEqual(supervisor.contributions.getSnapshot().navigation, []);
  await supervisor.deactivate("lightvela.platform");
  await supervisor.dispose();
});

test("Collaboration client uses the shared LightVela account transport", async () => {
  const requests: Array<{ readonly path: string; readonly method: string }> = [];
  const client = new CollaborationClient({
    async requestRaw<T>(path: string, init: RequestInit = {}): Promise<T> {
      requests.push({ path, method: init.method ?? "GET" });
      return {
        items: [{
          id: "01989c24-7540-7f12-a27b-c83243215dd3",
          slug: "builders",
          name: "Builders",
          ownerMemberId: "01989c24-7540-7f12-a27b-c83243215dd4",
          imState: "ready",
          revision: 2,
        }],
        nextCursor: null,
      } as T;
    },
  });

  const page = await client.listServers();

  assert.deepEqual(requests, [{ path: "/v1/collaboration/servers", method: "GET" }]);
  assert.equal(page.items[0]?.name, "Builders");
  assert.equal(page.nextCursor, null);
});

test("Collaboration client obtains a short-lived Human IM session", async () => {
  const requests: Array<{ readonly path: string; readonly method: string }> = [];
  const client = new CollaborationClient({
    async requestRaw<T>(path: string, init: RequestInit = {}): Promise<T> {
      requests.push({ path, method: init.method ?? "GET" });
      return {
        sdkAppId: 1_400_000_001,
        userId: "u_agent_collaborator",
        userSig: "short-lived-user-sig",
        expiresAt: "2026-09-14T12:30:00Z",
      } as T;
    },
  });

  const session = await client.createHumanImSession();

  assert.deepEqual(requests, [{ path: "/v1/collaboration/me/im/session", method: "POST" }]);
  assert.equal(session.userId, "u_agent_collaborator");
  assert.equal(session.userSig, "short-lived-user-sig");
});

test("Collaboration client resolves the JIT-mapped Human account", async () => {
  const requests: string[] = [];
  const client = new CollaborationClient({
    async requestRaw<T>(path: string): Promise<T> {
      requests.push(path);
      return {
        id: "account-1",
        displayName: "Ada",
        email: "",
        imState: "ready",
        imUserId: "human-1",
        revision: 1,
      } as T;
    },
  });

  const account = await client.getMe();

  assert.deepEqual(requests, ["/v1/collaboration/me/profile"]);
  assert.equal(account.imUserId, "human-1");
});

test("Collaboration client loads the unified IM directory through stable Server paths", async () => {
  const requests: string[] = [];
  const client = new CollaborationClient({
    async requestRaw<T>(path: string): Promise<T> {
      requests.push(path);
      if (path.endsWith("/channels")) return [{ id: "channel-1" }] as T;
      if (path.includes("/members")) {
        return path.includes("cursor=members-2")
          ? { items: [{ id: "member-2" }], nextCursor: null } as T
          : { items: [{ id: "member-1" }], nextCursor: "members-2" } as T;
      }
      if (path.endsWith("/direct-conversations")) {
        return { items: [{ id: "direct-1" }], nextCursor: null } as T;
      }
      throw new Error(`unexpected request ${path}`);
    },
  });

  const [channels, members, direct] = await Promise.all([
    client.listChannels("server-1"),
    client.listMembers("server-1"),
    client.listDirectConversations("server-1"),
  ]);

  assert.deepEqual(channels, [{ id: "channel-1" }]);
  assert.deepEqual(members, [{ id: "member-1" }, { id: "member-2" }]);
  assert.deepEqual(direct, [{ id: "direct-1" }]);
  assert.deepEqual(requests.sort(), [
    "/v1/collaboration/servers/server-1/channels",
    "/v1/collaboration/servers/server-1/direct-conversations",
    "/v1/collaboration/servers/server-1/members",
    "/v1/collaboration/servers/server-1/members?cursor=members-2",
  ].sort());
});

test("Collaboration client creates a private Group through the Server member contract", async () => {
  let request: { path: string; init?: RequestInit } | null = null;
  const client = new CollaborationClient({
    async requestRaw<T>(path: string, init?: RequestInit): Promise<T> {
      request = { path, init };
      return { kind: "ready", resource: { id: "direct-1" } } as T;
    },
  });

  await client.createDirectConversation("server-1", "member-1", "request-1");

  assert.equal(request?.path, "/v1/collaboration/servers/server-1/direct-conversations");
  assert.equal(request?.init?.method, "POST");
  assert.equal(new Headers(request?.init?.headers).get("Idempotency-Key"), "request-1");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { peerMemberId: "member-1" });
});
