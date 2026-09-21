import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { AppServerBotDirectory } from "@opencraft/bot-conversation-appserver";
import type { AppServerBotConversationService } from "@opencraft/bot-conversation-appserver";
import { createBotManagementView } from "../components/bot-management";

export function createBotManagementExtension(directory: AppServerBotDirectory, conversations: AppServerBotConversationService,
  connect: (hostId: string) => Promise<void>): TrustedExtensionDefinition {
  return {
    manifest: { manifestVersion: 1, id: "vela.bot-management", name: "Bots", version: "0.1.0", apiVersion: 1,
      trust: "trusted", platforms: ["web", "electron"], activationEvents: ["onStartupFinished"] },
    activate(api) {
      api.views.register({ id: "vela.bot-management.view", viewType: "vela.bot-management.surface", title: "Bots", icon: "bot", platforms: ["web", "electron"], audience: "internal" });
      api.navigation.register({ id: "vela.bot-management.navigation", title: "Bots", icon: "bot", surface: "sidebar-primary",
        target: { kind: "view", viewId: "vela.bot-management.view" }, order: 30, platforms: ["web", "electron"], audience: "internal" });
      api.internal.register("platformViewRenderer", { viewType: "vela.bot-management.surface", Component: createBotManagementView(directory, conversations, connect) });
    },
  };
}
