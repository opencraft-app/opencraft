import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import type { Message } from "@lightvela/vela-chat-client-core";
import { CollaborationWorkspaceController } from "../../plugins/lightvela-collaboration/src/collaboration-workspace-controller";
import { createCollaborationWorkspaceView } from "../../plugins/lightvela-collaboration/src/collaboration-workspace-view";
import { CollaborationWorkspaceService } from "../../plugins/lightvela-collaboration/src/collaboration-workspace-service";
import { ImChatService } from "../../plugins/lightvela-collaboration/src/im-chat-service";
import { ImDirectoryService } from "../../plugins/lightvela-collaboration/src/im-directory-service";
import { serializeCollaborationWorkspaceRoute } from "../../plugins/lightvela-collaboration/src/workspace-route";
import "../../plugins/lightvela-collaboration/src/styles.css";

const server = {
  id: "server-1", slug: "builders", name: "Builders", ownerMemberId: "member-self",
  imState: "ready" as const, revision: 1,
};
const self = {
  id: "member-self", serverId: server.id, accountId: "account-1", kind: "human" as const,
  role: "owner" as const, displayName: "Skip", handle: "skip", imUserId: "human-self",
  imState: "ready" as const, status: "active" as const, revision: 1,
};
const ada = {
  id: "member-ada", serverId: server.id, accountId: "account-2", kind: "human" as const,
  role: "member" as const, displayName: "Ada", handle: "ada", imUserId: "human-ada",
  imState: "ready" as const, status: "active" as const, revision: 1,
};
const channel = {
  id: "channel-general", serverId: server.id, name: "general", visibility: "public" as const,
  joined: true, systemKey: "all" as const, imGroupId: "community-1", imTopicId: "topic-general",
  imState: "ready" as const, revision: 1,
};
const account = {
  id: "account-1", displayName: "Skip", email: "", imState: "ready" as const,
  imUserId: "human-self", revision: 1,
};

const direct: any = {
  id: "direct-1", serverId: server.id, memberA: self, memberB: ada, status: "active",
  imGroupId: "direct-group-1", imState: "ready", revision: 1,
};
let directItems: any[] = [];
const client: any = {
  getMe: async () => account,
  listServers: async () => ({ items: [server], nextCursor: null }),
  listChannels: async () => [channel],
  listMembers: async () => [self, ada],
  listDirectConversations: async () => directItems,
	listComputersV2: async () => [],
	attachComputerV2: async () => { throw new Error("Computer is disabled"); },
  createDirectConversation: async () => {
    directItems = [direct];
    return { kind: "ready", resource: direct };
  },
};

function message(conversationId: string, text: string): Message {
  return {
    id: `${conversationId}:${text}`,
    conversationId,
    content: { kind: "text", text },
    createdAt: new Date().toISOString(),
    delivery: { state: "sent" },
    direction: "incoming",
    kind: "text",
    mentions: [],
    rawType: "TIMTextElem",
    reactions: [],
    read: { state: "unknown" },
    senderId: "human-ada",
    senderName: "Ada",
    text,
  };
}

const messaging: any = {
  connect: async () => undefined,
  close: async () => undefined,
  setScope: async () => undefined,
  waitUntilReady: async () => undefined,
  loadHistory: async (address: any) => ({
    completed: true,
    messages: [message(address.conversationId, address.directConversationId ? "这是一条私聊消息。" : "欢迎来到 #general。")],
  }),
  markRead: async () => undefined,
  sendText: async (input: any) => ({ ...message(input.channel.conversationId, input.text), direction: "outgoing", senderName: "Skip" }),
  subscribeMessages: () => () => undefined,
};

const workspace = new CollaborationWorkspaceService(client, messaging, {
	listInstances: async () => [],
});
const directory = new ImDirectoryService(client, messaging, { createRequestId: () => "preview-request" });
const chat = new ImChatService(messaging, { createRequestId: () => "preview-message" });
const controller = new CollaborationWorkspaceController(workspace, directory, chat);
const Workspace = createCollaborationWorkspaceView({
	workspace, directory, chat, controller, computersEnabled: false,
});

function Preview() {
  const initial = serializeCollaborationWorkspaceRoute({ kind: "chat", serverId: server.id });
  const [resourceUri, setResourceUri] = useState(initial);
  const host = useMemo(() => ({
    platform: "web" as const,
    activeHostId: "",
    profiles: [],
    provisionHost: async () => { throw new Error("not used"); },
    removeHost: async () => false,
    openView: (_viewId: string, next: string | null = null) => next && setResourceUri(next),
    pushViewResource: (_viewId: string, next: string) => {
      window.history.pushState({}, "", `?resource=${encodeURIComponent(next)}`);
      setResourceUri(next);
    },
    replaceViewResource: (_viewId: string, next: string) => {
      window.history.replaceState({}, "", `?resource=${encodeURIComponent(next)}`);
      setResourceUri(next);
    },
  }), []);
  return <Workspace activation={{ viewId: "lightvela.collaboration.workspace-view", resourceUri }} contribution={{ id: "lightvela.collaboration.workspace-view", title: "Collaboration", viewType: "lightvela.collaboration.workspace" }} host={host} />;
}

const style = document.createElement("style");
style.textContent = `:root{font-family:Inter,system-ui,sans-serif;color-scheme:light;--color-text:#202124;--color-text-secondary:#6b6f76;--color-text-danger:#b42318;--color-text-button-primary:#fff;--color-background-primary:#f7f7f5;--color-background-secondary:#e9e9e4;--color-background-surface:#fff;--color-background-button-primary:#202124;--color-border-subtle:#deded8;--color-accent:#202124}*{box-sizing:border-box}html,body,#root{width:100%;height:100%;margin:0}`;
document.head.append(style);
createRoot(document.getElementById("root")!).render(<Preview />);
