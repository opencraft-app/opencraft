import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";
import type { MessagingPort } from "@lightvela/vela-chat-client-core";
import { createElement, useEffect, useRef, useSyncExternalStore } from "react";
import {
  CollaborationAccountRuntime,
  type CollaborationAccountAuthority,
} from "./collaboration-account-runtime";

import {
  CollaborationClient,
  type LightVelaAccountRequestPort,
} from "./collaboration-client";
import {
  CollaborationMessagingService,
} from "./collaboration-messaging-service";
import { CollaborationWorkspaceService } from "./collaboration-workspace-service";
import type { LightVelaInstanceDirectoryPort } from "./collaboration-workspace-service";
import { CollaborationWorkspaceController } from "./collaboration-workspace-controller";
import { createCollaborationWorkspaceView } from "./collaboration-workspace-view";
import { ImChatService } from "./im-chat-service";
import { ImDirectoryService } from "./im-directory-service";
import { createTencentWebMessagingPort } from "./im/create-tencent-web-messaging";
import { serializeCollaborationWorkspaceRoute } from "./workspace-route";

export interface LightVelaCollaborationExtensionOptions {
  readonly account: LightVelaAccountRequestPort & LightVelaInstanceDirectoryPort & CollaborationAccountAuthority;
  readonly messaging?: MessagingPort;
	readonly enableComputers?: boolean;
}

export function createLightVelaCollaborationExtension(
  options: LightVelaCollaborationExtensionOptions,
): TrustedExtensionDefinition {
	const computersEnabled = options.enableComputers ?? false;
  const runtime = new CollaborationAccountRuntime(options.account, ({ beforeConnect }) => {
    const client = new CollaborationClient(options.account);
    const messagingPort = options.messaging ?? createTencentWebMessagingPort();
    const messaging = new CollaborationMessagingService(client, messagingPort, beforeConnect);
    const workspace = new CollaborationWorkspaceService(client, messaging, options.account, computersEnabled);
    const directory = new ImDirectoryService(client, messagingPort);
    const chat = new ImChatService(messagingPort);
    const controller = new CollaborationWorkspaceController(workspace, directory, chat, computersEnabled);
    const Component = createCollaborationWorkspaceView({
      workspace, directory, chat, controller, computersEnabled,
    });
    return {
      Component,
      invalidate() {
        chat.dispose();
        directory.dispose();
      },
      dispose: () => workspace.dispose(),
    };
  });
  function WorkspaceView(props: ExtensionSettingsViewProps) {
    const current = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
    const previousAuthority = useRef(current.authGeneration);
    const authorityChanged = previousAuthority.current !== current.authGeneration;
    const home = serializeCollaborationWorkspaceRoute({ kind: "home" });
    useEffect(() => {
      if (previousAuthority.current === current.authGeneration) return;
      previousAuthority.current = current.authGeneration;
      props.host.replaceViewResource(props.activation.viewId, home);
    }, [current.authGeneration, home, props.activation.viewId, props.host]);
    return createElement(current.scope.Component, {
      ...props,
      activation: authorityChanged ? { ...props.activation, resourceUri: home } : props.activation,
      key: current.authGeneration,
    });
  }
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
      runtime.start();
      api.subscriptions.add(() => runtime.dispose());
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
