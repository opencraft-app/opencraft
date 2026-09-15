import {
  channelAddress,
  directAddress,
  type ConversationAddress,
} from "@lightvela/vela-chat-client-core";

import type { ImDirectorySnapshot } from "./im-directory-service";
import type { CollaborationWorkspaceRoute } from "./workspace-route";

export interface WorkspaceCatalogOwner {
  load(): Promise<void>;
	loadComputers(serverId: string): Promise<void>;
}

export interface WorkspaceDirectoryOwner {
  load(serverId: string): Promise<void>;
  getSnapshot(): ImDirectorySnapshot;
}

export interface WorkspaceChatOwner {
  open(address: ConversationAddress): Promise<void>;
}

export class CollaborationWorkspaceController {
  constructor(
    private readonly workspace: WorkspaceCatalogOwner,
    private readonly directory: WorkspaceDirectoryOwner,
    private readonly chat: WorkspaceChatOwner,
	private readonly computersEnabled = false,
  ) {}

  async activate(route: CollaborationWorkspaceRoute): Promise<void> {
	await this.workspace.load();
	if (route.kind === "home") return;
	if (route.kind === "computers" || route.kind === "computer") {
	  if (!this.computersEnabled) return;
	  await this.workspace.loadComputers(route.serverId);
	  return;
	}
    await this.directory.load(route.serverId);
    if (route.kind === "chat" || route.kind === "member") return;
    const snapshot = this.directory.getSnapshot();
    if (route.kind === "direct") {
      const conversation = snapshot.directConversations.find(
        (candidate) => candidate.id === route.directConversationId,
      );
      const address = conversation === undefined ? null : directAddress({
        directConversationId: conversation.id,
        imGroupId: conversation.imGroupId,
        imState: conversation.imState,
      });
      if (address === null) throw new Error("Private conversation is unavailable");
      await this.chat.open(address);
      return;
    }
    const channel = snapshot.channels.find((candidate) => candidate.id === route.channelId);
    const address = channel === undefined ? null : channelAddress(channel);
    if (address === null) throw new Error("Channel conversation is unavailable");
    await this.chat.open(address);
  }
}
