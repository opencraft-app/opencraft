import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExtensionSupervisor, type InternalContributionAdapter } from "@opencraft/extension-runtime";
import { createLightVelaCollaborationExtension } from "../../plugins/lightvela-collaboration/src/extension";
import { serializeCollaborationWorkspaceRoute } from "../../plugins/lightvela-collaboration/src/workspace-route";
import "../../plugins/lightvela-collaboration/src/styles.css";

let authGeneration = 0;
let unauthorizedReads = 0;
let notifyFixture = () => {};
const authorityListeners = new Set<() => void>();
const server = { id: "server-1", slug: "builders", name: "Builders", ownerMemberId: "member-1", imState: "ready", revision: 1 };
const channel = { id: "channel-1", serverId: server.id, name: "general", visibility: "public", joined: true, systemKey: "all", imGroupId: "community-1", imTopicId: "topic-1", imState: "ready", revision: 1 };
const member = { id: "member-1", serverId: server.id, accountId: "account-0", imUserId: "human-0", displayName: "Sender", handle: "sender", kind: "human", role: "owner", status: "active", imState: "ready", revision: 1 };
const receiver = () => authGeneration % 2 === 1;
const account = {
  getSnapshot: () => ({ authGeneration }),
  subscribe(listener: () => void) { authorityListeners.add(listener); return () => { authorityListeners.delete(listener); }; },
  listInstances: async () => [],
  async requestRaw<T>(path: string): Promise<T> {
    const user = receiver() ? 1 : 0;
    let value: unknown;
    if (path.endsWith("/me/profile")) {
      value = { id: "account-" + user, displayName: user ? "Receiver" : "Sender", imUserId: "human-" + user, imState: "ready", revision: 1 };
    } else if (path.endsWith("/me/im/session")) {
      value = { sdkAppId: 1, userId: "human-" + user, userSig: "preview-test-user-sig", expiresAt: "2099-01-01T00:00:00Z" };
    } else if (path.endsWith("/servers")) {
      value = { items: user ? [] : [server], nextCursor: null };
    } else if (user) {
      unauthorizedReads += 1;
      notifyFixture();
      throw Object.assign(new Error("not a member"), { status: 403 });
    } else if (path.endsWith("/channels")) {
      value = [channel];
    } else if (path.endsWith("/members")) {
      value = { items: [member], nextCursor: null };
    } else if (path.endsWith("/direct-conversations")) {
      value = { items: [], nextCursor: null };
    } else if (path.endsWith("/invites")) {
      value = { invite: { id: "preview-invite" }, token: "rfi_mock_once_token_20261004" };
    } else {
      throw new Error("fixture operation not implemented");
    }
    return value as T;
  },
};
const messaging = {
  connect: async () => {},
  close: async () => {},
  setScope: async () => {},
  waitUntilReady: async () => {},
  loadHistory: async () => ({ completed: true, messages: [] }),
  markRead: async () => {},
  subscribeMessages: () => () => {},
};
let Workspace: React.ComponentType<any> | null = null;
const renderer: InternalContributionAdapter = {
  prepare(_owner, value) {
    return {
      commit: () => {
        Workspace = (value as { Component: React.ComponentType<any> }).Component;
        return () => { Workspace = null; };
      },
    };
  },
};
const supervisor = new ExtensionSupervisor({
  platform: "web",
  internalContributions: { platformViewRenderer: renderer },
});

function Fixture({ View }: { View: React.ComponentType<any> }) {
  const [, refresh] = useState(0);
  const [resourceUri, setResourceUri] = useState(serializeCollaborationWorkspaceRoute({ kind: "chat", serverId: server.id }));
  const host = useMemo(() => ({
    pushViewResource: (_view: string, uri: string) => { window.history.pushState({}, "", "?resource=" + encodeURIComponent(uri)); setResourceUri(uri); },
    replaceViewResource: (_view: string, uri: string) => { window.history.replaceState({}, "", "?resource=" + encodeURIComponent(uri)); setResourceUri(uri); },
  }), []);
  useEffect(() => { notifyFixture = () => refresh((value) => value + 1); return () => { notifyFixture = () => {}; }; }, []);
  return <>
    <View activation={{ viewId: "lightvela.collaboration.workspace-view", resourceUri }} host={host} />
    <aside className="fixture-controls">
      <span>模拟账户：{receiver() ? "Receiver" : "Sender"}</span>
      <span>旧 Server 目录请求：{unauthorizedReads}</span>
      <button type="button" onClick={() => { authGeneration += 1; authorityListeners.forEach((listener) => listener()); notifyFixture(); }}>模拟切换账户</button>
    </aside>
  </>;
}

async function start() {
  await supervisor.activate({
    manifest: { manifestVersion: 1, id: "lightvela.platform", name: "Preview Platform", version: "0.1.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["onStartupFinished"] },
    activate() {},
  });
  await supervisor.activate(createLightVelaCollaborationExtension({ account, messaging: messaging as never }));
  if (Workspace === null) throw new Error("Preview renderer missing");
  createRoot(document.getElementById("root")!).render(<Fixture View={Workspace} />);
}
void start();
window.addEventListener("beforeunload", () => { void supervisor.dispose(); });
