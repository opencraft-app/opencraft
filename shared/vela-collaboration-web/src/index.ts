import type { LightVelaAccountRequestPort } from "./collaboration-client";
import type { MessagingPort } from "@lightvela/vela-chat-client-core";
import { CollaborationClient } from "./collaboration-client";
import { CollaborationMessagingService } from "./collaboration-messaging-service";
import { CollaborationWorkspaceService } from "./collaboration-workspace-service";
import { CollaborationWorkspaceController } from "./collaboration-workspace-controller";
import { createCollaborationWorkspaceView } from "./collaboration-workspace-view";
import { ImChatService } from "./im-chat-service";
import { ImDirectoryService } from "./im-directory-service";
import { createTencentWebMessagingPort } from "./im/create-tencent-web-messaging";

export type { LightVelaAccountRequestPort } from "./collaboration-client";
export type { CollaborationWorkspaceViewProps } from "./collaboration-workspace-view";
export { serializeCollaborationWorkspaceRoute } from "./workspace-route";

/** One account owns one workspace and one IM connection, independent of a Bot. */
export function createCollaborationScope(
  account: LightVelaAccountRequestPort,
  beforeConnect: Promise<void> = Promise.resolve(),
  messagingPort: MessagingPort = createTencentWebMessagingPort(),
) {
  const client = new CollaborationClient(account);
  const messaging = new CollaborationMessagingService(client, messagingPort, beforeConnect);
  const workspace = new CollaborationWorkspaceService(client, messaging, { listInstances: async () => [] }, false);
  const directory = new ImDirectoryService(client, messagingPort);
  const chat = new ImChatService(messagingPort);
  const controller = new CollaborationWorkspaceController(workspace, directory, chat, false);
  const Component = createCollaborationWorkspaceView({ workspace, directory, chat, controller, computersEnabled: false });
  let disposed = false;
  return {
    Component,
    dispose() {
      if (!disposed) {
        disposed = true;
        chat.dispose();
        directory.dispose();
      }
      return workspace.dispose();
    },
  };
}
