import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { MessagingPort } from "@lightvela/vela-chat-client-core";

import {
  CollaborationClient,
  type LightVelaAccountRequestPort,
} from "./collaboration-client";
import {
  CollaborationMessagingService,
  type MessagingLifecyclePort,
} from "./collaboration-messaging-service";
import { CollaborationWorkspaceService } from "./collaboration-workspace-service";
import type { LightVelaInstanceDirectoryPort } from "./collaboration-workspace-service";
import { CollaborationWorkspaceController } from "./collaboration-workspace-controller";
import { createCollaborationWorkspaceView } from "./collaboration-workspace-view";
import { ImChatService } from "./im-chat-service";
import { ImDirectoryService } from "./im-directory-service";
import { createTencentWebMessagingPort } from "./im/create-tencent-web-messaging";

export interface LightVelaCollaborationExtensionOptions {
  readonly account: LightVelaAccountRequestPort & LightVelaInstanceDirectoryPort;
  readonly messaging?: MessagingPort;
	readonly enableComputers?: boolean;
}

export function createLightVelaCollaborationExtension(
  options: LightVelaCollaborationExtensionOptions,
): TrustedExtensionDefinition {
  const client = new CollaborationClient(options.account);
  const messagingPort = options.messaging ?? createTencentWebMessagingPort();
  const messaging = new CollaborationMessagingService(client, messagingPort);
	const computersEnabled = options.enableComputers ?? false;
  const workspace = new CollaborationWorkspaceService(client, messaging, options.account, computersEnabled);
  const directory = new ImDirectoryService(client, messagingPort);
  const chat = new ImChatService(messagingPort);
	const controller = new CollaborationWorkspaceController(workspace, directory, chat, computersEnabled);
  const WorkspaceView = createCollaborationWorkspaceView({
    workspace,
    directory,
    chat,
    controller,
	computersEnabled,
  });
  return {
    manifest: {
      manifestVersion: 1,
      id: "lightvela.collaboration",
      name: "LightVela Collaboration",
      description: "Adds Server, Channel and collaborative work surfaces to OpenCraft.",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web"],
      activationEvents: ["onStartupFinished"],
      dependencies: ["lightvela.platform"],
    },
    activate(api) {
      api.subscriptions.add(async () => {
        chat.dispose();
        await workspace.dispose();
      });
      api.views.register({
        id: "lightvela.collaboration.workspace-view",
        title: "Collaboration",
        viewType: "lightvela.collaboration.workspace",
        icon: "message-circle",
        platforms: ["web"],
      });
      api.navigation.register({
        id: "lightvela.collaboration.workspace",
        title: "Collaboration",
        surface: "sidebar-primary",
        target: {
          kind: "view",
          viewId: "lightvela.collaboration.workspace-view",
        },
        order: 200,
        icon: "message-circle",
        platforms: ["web"],
      });
      api.internal.register("platformViewRenderer", {
        viewType: "lightvela.collaboration.workspace",
        Component: WorkspaceView,
      });
    },
  };
}
