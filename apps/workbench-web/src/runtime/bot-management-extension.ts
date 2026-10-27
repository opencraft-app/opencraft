import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { AppServerBotDirectory } from "@opencraft/bot-conversation-appserver";
import type { AppServerBotConversationService } from "@opencraft/bot-conversation-appserver";
import { createBotManagementView } from "../components/bot-management";
import { resolveBotManagementPolicy, type ClientBotManagementPolicy } from "@opencraft/client-product";

export function createBotManagementExtension(directory: AppServerBotDirectory, conversations: AppServerBotConversationService,
  connect: (hostId: string) => Promise<void>, policy?: ClientBotManagementPolicy): TrustedExtensionDefinition {
  const resolvedPolicy = resolveBotManagementPolicy(policy);
  return {
    manifest: { manifestVersion: 1, id: "opencraft.bot-management", name: "Bots", version: "0.1.0", apiVersion: 1,
      trust: "trusted", platforms: ["web", "electron"], activationEvents: ["onStartupFinished"] },
    activate(api) {
      api.views.register({ id: "opencraft.bot-management.view", viewType: "opencraft.bot-management.surface", title: "Bots", icon: "bot", platforms: ["web", "electron"], audience: "internal" });
      api.navigation.register({ id: "opencraft.bot-management.navigation", title: "Bots", titleMessage: { id: "sidebar.bots", defaultMessage: "Bots" },
        shortTitleMessage: { id: "sidebar.rail.bots.short", defaultMessage: "Bots" }, icon: "bot", surface: "sidebar-primary",
        target: { kind: "view", viewId: "opencraft.bot-management.view" }, order: 30, platforms: ["web", "electron"], audience: "internal" });
      api.internal.register("platformViewRenderer", { viewType: "opencraft.bot-management.surface", Component: createBotManagementView(directory, conversations, connect, resolvedPolicy) });
    },
  };
}
