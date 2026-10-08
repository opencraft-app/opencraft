/** Wire contract for the packaged frontend Bot runtime and the native Expo shell. */
export const MOBILE_BOT_BRIDGE_VERSION = 1 as const;
export const MOBILE_BOT_EVENT = "opencraft-mobile-bot-command" as const;

import { AVATAR_SHAPES } from "./avatar-shapes";

export type BotSummary = { id: string; instanceId: string; profileId: string; name: string; status: string; isDefault: boolean };
export type BotToHostMessage =
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
  | { type: "select"; section: string; botId: string }
  | { type: "refresh" }
  | { type: "create" }
  | { type: "delete"; botId: string }
  | { type: "link"; href: string };

export const BOT_COMMAND_CAPABILITIES = ["select", "refresh", "create", "delete", "link"] as const;

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
    case "bot-runtime-ready": return typeof value.originMatches === "boolean"
      && Array.isArray(value.capabilities)
      && value.capabilities.includes("select")
      && value.capabilities.length <= BOT_COMMAND_CAPABILITIES.length
      && value.capabilities.every((item: unknown) => BOT_COMMAND_CAPABILITIES.includes(item as BotCommand["type"]))
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
    case "signed-out": case "bot-api-network-failed": return value as BotToHostMessage;
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
