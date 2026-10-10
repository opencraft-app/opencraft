/** Wire contract for the packaged frontend Bot runtime and the native Expo shell. */
export const MOBILE_BOT_BRIDGE_VERSION = 1 as const;
export const MOBILE_BOT_EVENT = "opencraft-mobile-bot-command" as const;

import { AVATAR_SHAPES } from "./avatar-shapes";
export type { AutomationDraft, AutomationJob } from "./automations";
import { isHostPanelCommand, isHostPanelGeometry, isHostPanelGesture, isHostPanelState, type HostPanelCommand, type HostPanelGeometry, type HostPanelGesture, type HostPanelState } from "@opencraft/workbench-panels/host-presentation";
export { resolveHostPanelGeometry } from "@opencraft/workbench-panels/host-presentation";
export type { HostPanelCommand, HostPanelGeometry, HostPanelGesture, HostPanelState } from "@opencraft/workbench-panels/host-presentation";

export type BotSummary = { id: string; instanceId: string; profileId: string; name: string; status: string; isDefault: boolean };
export type BotSessionSummary = { chatId: string; title: string; pinned: boolean; unread: boolean };
export type BotNavigationGroup = { id: string; label: string; sections: readonly { id: string; label: string }[] };
export type BotConsoleState = {
  type: "bot-console-state";
  botId: string;
  section: string;
  groups: readonly BotNavigationGroup[];
  sessions: readonly BotSessionSummary[];
  selectedChatId: string | null;
  loading: boolean;
  hasMore: boolean;
  commandsReady: boolean;
  pinSupported: boolean;
  pending: boolean;
  error: boolean;
};
export type BotSessionAction =
  | { action: "create" | "load-more" }
  | { action: "select" | "delete" | "unread"; chatId: string }
  | { action: "rename"; chatId: string; title: string }
  | { action: "pin"; chatId: string; pinned: boolean }
;
export type BotSessionCommand = { type: "session"; botId: string } & BotSessionAction;
export type NativeAudioRequest = { type: "native-audio-request"; id: string; action: "start" | "stop" | "cancel" };
export type NativeAudioEvent = { type: "native-audio-event"; id: string } & (
  | { event: "ready" }
  | { event: "level"; level: number }
  | { event: "chunk"; index: number; base64: string }
  | { event: "complete"; chunks: number }
  | { event: "error"; reason: "permission" | "capture" | "cancelled" }
);
const audioId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
export function isNativeAudioEvent(value: unknown): value is NativeAudioEvent {
  if (!record(value) || value.type !== "native-audio-event" || !audioId(value.id)) return false;
  switch (value.event) {
    case "ready": return true;
    case "level": return typeof value.level === "number" && Number.isFinite(value.level) && value.level >= 0 && value.level <= 1;
    case "chunk": return safeNumber(value.index) && value.index < 100 && typeof value.base64 === "string" && value.base64.length <= 65536 && value.base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64);
    case "complete": return safeNumber(value.chunks) && value.chunks > 0 && value.chunks <= 100;
    case "error": return value.reason === "permission" || value.reason === "capture" || value.reason === "cancelled";
    default: return false;
  }
}
export type BotToHostMessage =
  | NativeAudioRequest
  | { type: "bot-touch-ownership"; owned: boolean }
  | { type: "chat-panel-presentation"; ownerId: string; active: boolean }
  | { type: "chat-panel-state"; instanceId: string; profileId: string; state: HostPanelState }
  | { type: "chat-panel-action-failed" }
  | BotConsoleState
  | { type: "bot-runtime-ready"; originMatches: boolean; capabilities: readonly BotCommand["type"][] }
  | { type: "bot-auth-state"; ready: boolean; authenticated: boolean }
  | { type: "bot-catalog"; loading: boolean; error: boolean; bots: readonly BotSummary[] }
  | { type: "bot-avatar"; botId: string; configured: boolean; shapeId: string; color: string }
  | { type: "bot-selection"; section: string; botId: string }
  | { type: "bot-create-state"; visible: boolean; enabled: boolean }
  | { type: "external-navigation"; href: string; replace: boolean }
  | { type: "signed-out" }
  | { type: "bot-runtime-script-failed"; kind: number; line: number; column: number }
  | { type: "bot-section-render-failed"; section?: string }
  | { type: "bot-api-network-failed" }
  | { type: "bot-api-http-failed"; status: number; endpoint: number }
  | { type: "bot-model-load-failed"; kind: number };

export type BotCommand =
  | NativeAudioEvent
  | { type: "chat-panel"; command: HostPanelCommand }
  | { type: "chat-panel-geometry"; ownerId: string; geometry: HostPanelGeometry }
  | { type: "chat-panel-gesture"; ownerId: string; gesture: HostPanelGesture }
  | BotSessionCommand
  | { type: "visibility"; active: boolean }
  | { type: "select"; section: string; botId: string }
  | { type: "refresh" }
  | { type: "create" }
  | { type: "delete"; botId: string }
  | { type: "link"; href: string };

export const BOT_COMMAND_CAPABILITIES = ["select", "refresh", "create", "delete", "link", "session", "visibility", "chat-panel", "chat-panel-geometry", "chat-panel-gesture"] as const;

type BridgeEnvelope<T> = { protocol: typeof MOBILE_BOT_BRIDGE_VERSION; runtimeId: string; payload: T };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const shortText = (value: unknown): value is string => typeof value === "string" && value.length <= 2048;
const safeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const botSummary = (value: unknown): value is BotSummary => record(value)
  && shortText(value.id) && value.id.length > 0 && shortText(value.name)
  && shortText(value.instanceId) && /^[a-zA-Z0-9_-]+$/.test(value.instanceId)
  && shortText(value.profileId) && value.profileId.length > 0 && value.profileId.length <= 128
  && !/[\u0000-\u001f\u007f]/u.test(value.profileId)
  && shortText(value.status) && typeof value.isDefault === "boolean";

export function encodeBotBridgeMessage<T extends BotToHostMessage | BotCommand>(runtimeId: string, payload: T): string {
  return JSON.stringify({ protocol: MOBILE_BOT_BRIDGE_VERSION, runtimeId, payload } satisfies BridgeEnvelope<T>);
}

function parseEnvelope(raw: string, expectedRuntimeId: string): unknown {
  if (raw.length > 128_000 || !expectedRuntimeId) return null;
  try {
    const envelope: unknown = JSON.parse(raw);
    if (!record(envelope) || envelope.protocol !== MOBILE_BOT_BRIDGE_VERSION || envelope.runtimeId !== expectedRuntimeId) return null;
    return envelope.payload;
  } catch { return null; }
}

export function parseBotToHostMessage(raw: string, expectedRuntimeId: string): BotToHostMessage | null {
  const value = parseEnvelope(raw, expectedRuntimeId);
  if (!record(value)) return null;
  switch (value.type) {
    case "native-audio-request": return audioId(value.id) && (value.action === "start" || value.action === "stop" || value.action === "cancel") ? value as NativeAudioRequest : null;
    case "chat-panel-presentation": return shortText(value.ownerId) && value.ownerId.length > 0 && typeof value.active === "boolean" ? value as BotToHostMessage : null;
    case "bot-touch-ownership": return typeof value.owned === "boolean" ? value as BotToHostMessage : null;
    case "chat-panel-state": return shortText(value.instanceId) && value.instanceId.length > 0 && shortText(value.profileId) && value.profileId.length > 0 && isHostPanelState(value.state) ? value as BotToHostMessage : null;
    case "bot-console-state": return shortText(value.botId) && shortText(value.section)
      && (value.selectedChatId === null || shortText(value.selectedChatId))
      && ["loading", "hasMore", "commandsReady", "pinSupported", "pending", "error"].every(key => typeof value[key] === "boolean")
      && Array.isArray(value.sessions) && value.sessions.length <= 1000
      && value.sessions.every((item: unknown) => record(item) && shortText(item.chatId) && shortText(item.title) && typeof item.pinned === "boolean" && typeof item.unread === "boolean")
      && Array.isArray(value.groups) && value.groups.length <= 8
      && value.groups.every((item: unknown) => record(item) && shortText(item.id) && shortText(item.label)
        && Array.isArray(item.sections) && item.sections.length <= 24
        && item.sections.every((section: unknown) => record(section) && shortText(section.id) && shortText(section.label)))
      ? value as BotToHostMessage : null;
    case "bot-runtime-ready": return typeof value.originMatches === "boolean"
      && Array.isArray(value.capabilities)
      && value.capabilities.includes("select")
      && value.capabilities.length <= BOT_COMMAND_CAPABILITIES.length
      && value.capabilities.every((item: unknown) => BOT_COMMAND_CAPABILITIES.includes(item as typeof BOT_COMMAND_CAPABILITIES[number]))
      ? value as BotToHostMessage : null;
    case "bot-auth-state": return typeof value.ready === "boolean" && typeof value.authenticated === "boolean" ? value as BotToHostMessage : null;
    case "bot-catalog": return typeof value.loading === "boolean" && typeof value.error === "boolean"
      && Array.isArray(value.bots) && value.bots.length <= 1000 && value.bots.every(botSummary) ? value as BotToHostMessage : null;
    case "bot-avatar": return shortText(value.botId) && value.botId.length > 0
      && typeof value.configured === "boolean"
      && typeof value.shapeId === "string" && AVATAR_SHAPES.some(shape => shape.id === value.shapeId)
      && typeof value.color === "string" && /^#[0-9a-fA-F]{6}$/.test(value.color)
      ? value as BotToHostMessage : null;
    case "bot-selection": return shortText(value.section) && shortText(value.botId) ? value as BotToHostMessage : null;
    case "bot-create-state": return typeof value.visible === "boolean" && typeof value.enabled === "boolean" ? value as BotToHostMessage : null;
    case "external-navigation": return shortText(value.href) && typeof value.replace === "boolean" ? value as BotToHostMessage : null;
    case "bot-section-render-failed": return value.section === undefined || shortText(value.section) ? value as BotToHostMessage : null;
    case "signed-out": case "bot-api-network-failed": case "chat-panel-action-failed": return value as BotToHostMessage;
    case "bot-runtime-script-failed": return safeNumber(value.kind) && safeNumber(value.line) && safeNumber(value.column) ? value as BotToHostMessage : null;
    case "bot-api-http-failed": return safeNumber(value.status) && safeNumber(value.endpoint) ? value as BotToHostMessage : null;
    case "bot-model-load-failed": return safeNumber(value.kind) ? value as BotToHostMessage : null;
    default: return null;
  }
}

export function parseBotCommand(raw: string, expectedRuntimeId: string): BotCommand | null {
  const value = parseEnvelope(raw, expectedRuntimeId);
  if (!record(value)) return null;
  switch (value.type) {
    case "native-audio-event": return isNativeAudioEvent(value) ? value : null;
    case "chat-panel": return isHostPanelCommand(value.command) ? value as BotCommand : null;
    case "chat-panel-gesture": return shortText(value.ownerId) && value.ownerId.length > 0 && isHostPanelGesture(value.gesture) ? value as BotCommand : null;
    case "chat-panel-geometry": return shortText(value.ownerId) && value.ownerId.length > 0 && isHostPanelGeometry(value.geometry) ? value as BotCommand : null;
    case "visibility": return typeof value.active === "boolean" ? value as BotCommand : null;
    case "session": {
      if (!shortText(value.botId) || !value.botId) return null;
      if (value.action === "create" || value.action === "load-more") return value as BotCommand;
      if (!shortText(value.chatId)) return null;
      if (value.action === "select" || value.action === "unread") return value as BotCommand;
      if (!value.chatId) return null; // A draft is never a rename/delete/pin target.
      if (value.action === "delete") return value as BotCommand;
      if (value.action === "rename" && shortText(value.title) && value.title.trim().length > 0 && value.title.length <= 256) return value as BotCommand;
      if (value.action === "pin" && typeof value.pinned === "boolean") return value as BotCommand;
      return null;
    }
    case "select": return shortText(value.section) && shortText(value.botId) ? value as BotCommand : null;
    case "delete": return shortText(value.botId) && value.botId.length > 0 ? value as BotCommand : null;
    case "link": return shortText(value.href) ? value as BotCommand : null;
    case "refresh": case "create": return value as BotCommand;
    default: return null;
  }
}

/** Inject a single command event; JSON encoding prevents source text injection. */
export function botCommandScript(runtimeId: string, command: BotCommand): string {
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(MOBILE_BOT_EVENT)}, { detail: ${JSON.stringify(encodeBotBridgeMessage(runtimeId, command))} })); true;`;
}

/** Public mount port for the Expo Web surface; adapters own navigation/auth. */
export interface AgentsExpoWebOptions {
  runtimeHtmlUrl: string;
  region: "cn" | "intl";
  language: "zh-CN" | "en";
  token: string;
  account: { displayName: string | null; avatarUrl: string | null };
  onExternalNavigation(href: string): void;
  onOpenAccount(): void;
  onSignedOut(): void;
  onDiagnostic?(event: "runtime.failed" | "section.failed" | "api.failed" | "panel.failed"): void;
}
export interface AgentsExpoWebApplication {
  mount(element: HTMLElement, options: AgentsExpoWebOptions): { update(options: AgentsExpoWebOptions): void; dispose(): void };
}

/** Bound a renderer projection without advertising an unfulfillable load-more action. */
export function boundBotConsoleState(state: BotConsoleState): BotConsoleState {
  const sessions = state.sessions.slice(0, 1000).map(session => ({ ...session, title: session.title.slice(0, 256) }));
  const projected = { ...state, sessions };
  // Reserve room for the version/runtime envelope, including long runtime IDs.
  if (JSON.stringify(projected).length <= 120_000) return { ...projected, hasMore: state.hasMore && sessions.length < 1000 };
  let low = 0; let high = sessions.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    if (JSON.stringify({ ...projected, sessions: sessions.slice(0, count) }).length <= 120_000) low = count;
    else high = count - 1;
  }
  return { ...projected, sessions: sessions.slice(0, low), hasMore: false };
}
