import type {
  BotConversationResolver,
  BotConversationSource,
} from "@opencraft/bot-conversation";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { ComposerDraftStorage } from "@opencraft/composer-core";

import { createBotChatView } from "./bot-chat-view";

export interface CreateBotChatExtensionOptions {
  readonly drafts?: ComposerDraftStorage;
  /** AppServer-owned Bot state projected through a replaceable client port. */
  readonly source: BotConversationSource;
  /** AppServer-backed selector-to-exact-conversation transaction. */
  readonly resolver: BotConversationResolver;
  /** Shell can expose exact Bot cards without an empty standalone application entry. */
  readonly showNavigation?: boolean;
}

export function createBotChatExtension(
  options: CreateBotChatExtensionOptions,
): TrustedExtensionDefinition {
  const BotChatView = createBotChatView(options.source, {
    resolver: options.resolver,
    drafts: options.drafts,
  });
  return {
    manifest: {
      manifestVersion: 1,
      id: "opencraft.bot-chat",
      name: "OpenCraft Bot Chat",
      description:
        "A Bot-native animated conversation surface with a replaceable Source boundary.",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web", "electron"],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      api.views.register({
        id: "opencraft.bot-chat.view",
        title: "Bot chat",
        viewType: "opencraft.bot-chat.surface",
        role: "bot-conversation",
        icon: "bot",
        platforms: ["web", "electron"],
        audience: "internal",
      });
      if (options.showNavigation !== false) api.navigation.register({
        id: "opencraft.bot-chat.navigation",
        title: "Bot chat",
        surface: "sidebar-primary",
        target: { kind: "view", viewId: "opencraft.bot-chat.view" },
        icon: "bot",
        order: 20,
        platforms: ["web", "electron"],
        audience: "internal",
      });
      api.internal.register("platformViewRenderer", {
        viewType: "opencraft.bot-chat.surface",
        Component: BotChatView,
      });
    },
  };
}

export {
  createBotChatView,
  type BotChatViewOptions,
  type BotChatViewStatus,
} from "./bot-chat-view";
export {
  BOT_MOTION_REPLAY_SCENES,
  createBotMotionReplayController,
} from "./motion-replay";
