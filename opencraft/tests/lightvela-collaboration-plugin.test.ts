import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionSupervisor,
  type InternalContributionAdapter,
} from "@opencraft/extension-runtime";
import { createLightVelaCollaborationExtension } from "../plugins/lightvela-collaboration/src/extension";
import { CollaborationClient } from "../plugins/lightvela-collaboration/src/collaboration-client";

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
  const account = {
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
  await supervisor.activate(createLightVelaCollaborationExtension({ account }));

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

  assert.equal(await supervisor.deactivate("lightvela.collaboration"), true);
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

  assert.deepEqual(requests, ["/v1/collaboration/me"]);
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
