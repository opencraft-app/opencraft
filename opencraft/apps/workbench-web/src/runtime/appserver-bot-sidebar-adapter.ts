import { botSelectionResourceUri } from "@opencraft/bot-conversation";
import type {
  AppServerBotDirectory,
  AppServerBotDirectoryEntry,
  AppServerBotDirectoryHost,
} from "@opencraft/bot-conversation-appserver";
import {
  createSidebarEntityKey,
  type SidebarEntity,
  type SidebarEntityAvatar,
  type SidebarEntityCreationCommand,
} from "@opencraft/sidebar-layout";

function createClientRequestId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `opencraft-bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function avatarFor(entry: AppServerBotDirectoryEntry): SidebarEntityAvatar {
  const avatar = entry.bot.avatar;
  if (avatar?.type === "generated") {
    return Object.freeze({
      kind: "generated",
      seed: avatar.seed,
      ...(avatar.palette === undefined ? {} : { palette: avatar.palette }),
    });
  }
  if (avatar?.type === "resource") {
    return Object.freeze({ kind: "resource", uri: avatar.uri });
  }
  return Object.freeze({ kind: "generated", seed: `${entry.hostId}:${entry.bot.botId}` });
}

/** AppServer-specific policy boundary. The generic Workbench never fabricates Bot facts. */
export function projectAppServerBotSidebarEntity(
  entry: AppServerBotDirectoryEntry,
  botConversationViewId: string,
  openView: (viewId: string, resourceUri?: string | null) => void,
): SidebarEntity {
  const identity = Object.freeze({
    kind: "bot" as const,
    hostId: entry.hostId,
    entityId: entry.bot.botId,
  });
  const key = createSidebarEntityKey(identity);
  return Object.freeze({
    key,
    identity,
    title: entry.bot.name.trim() || "Bot",
    subtitle: entry.bot.subtitle ?? entry.hostId,
    avatar: avatarFor(entry),
    availability: entry.availability,
    order: 0,
    invoke: () => openView(
      botConversationViewId,
      botSelectionResourceUri(entry.hostId, entry.bot.botId),
    ),
  });
}

export function createAppServerBotCreationCommand(
  directory: AppServerBotDirectory,
  hosts: readonly AppServerBotDirectoryHost[],
  botConversationViewId: string,
  openView: (viewId: string, resourceUri?: string | null) => void,
): SidebarEntityCreationCommand | null {
  const targets = hosts
    .filter((host) => host.phase === "ready" && host.canManageBots)
    .map((host) => Object.freeze({ id: host.hostId, label: host.hostId }));
  if (targets.length === 0) return null;
  return Object.freeze({
    noun: "Bot",
    open: () => openView("vela.bot-management.view", `create:${createClientRequestId()}`),
    targets: Object.freeze(targets),
    async create(hostId: string, name: string) {
      const bot = await directory.create(hostId, {
        clientRequestId: createClientRequestId(),
        name,
      });
      const entityKey = createSidebarEntityKey({ kind: "bot", hostId, entityId: bot.botId });
      return Object.freeze({
        entityKey,
        invoke: () => openView(
          botConversationViewId,
          botSelectionResourceUri(hostId, bot.botId),
        ),
      });
    },
  });
}
