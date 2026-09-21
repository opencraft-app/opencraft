import { asJsonValue, type JsonValue } from "../types/domain.ts";

export const OPENAI_RESPONSES = "openai-responses" as const;
export const OPENAI_COMPLETIONS = "openai-completions" as const;

export type ModelApiProtocol = typeof OPENAI_RESPONSES | typeof OPENAI_COMPLETIONS;

export interface ModelProtocolRecord {
  readonly endpoint?: unknown;
  readonly providerId?: unknown;
  readonly displayName?: unknown;
  readonly model?: unknown;
  readonly apiProtocol?: unknown;
}

export interface PiAiCompatibility {
  supportsDeveloperRole?: false;
  maxTokensField?: "max_tokens";
  thinkingFormat?: "deepseek";
  requiresReasoningContentOnAssistantMessages?: true;
}

export interface SanitizedNativeResponse {
  readonly value: JsonValue;
  readonly repairs: number;
}

export interface SanitizedNativeResponsesBody {
  readonly body: string;
  readonly repairs: number;
}

function isTokenHubKimiK3(record: ModelProtocolRecord): boolean {
  const endpoint = String(record.endpoint ?? "").toLowerCase();
  const identity = [record.providerId, record.displayName, record.model]
    .map((value) => String(value ?? "").toLowerCase()).join(" ");
  return endpoint.includes("tokenhub.tencentmaas.com") && /kimi[ -]?k3/.test(identity);
}

export function inferModelProtocol(_record: ModelProtocolRecord = {}): ModelApiProtocol {
  // An endpoint that did not explicitly declare Responses is a Chat
  // Completions endpoint. Model names are capabilities, not wire protocols:
  // treating Kimi K3 as Responses here made DSH/pi-ai adapt the request once
  // and HyperNode adapt it a second time.
  return OPENAI_COMPLETIONS;
}

export function modelProtocol(record: ModelProtocolRecord = {}): ModelApiProtocol {
  const explicit = String(record.apiProtocol ?? "").trim();
  if (!explicit) return inferModelProtocol(record);
  if (explicit !== OPENAI_RESPONSES && explicit !== OPENAI_COMPLETIONS) {
    throw new Error(`unsupported model API protocol ${JSON.stringify(explicit)}`);
  }
  return explicit;
}

export function needsResponseIdSanitization(record: ModelProtocolRecord = {}): boolean {
  return modelProtocol(record) === OPENAI_RESPONSES && isTokenHubKimiK3(record);
}

export function needsInternalFinishTool(record: ModelProtocolRecord = {}): boolean {
  return modelProtocol(record) === OPENAI_RESPONSES && isTokenHubKimiK3(record);
}

export function piAiCompatForRecord(record: ModelProtocolRecord = {}): PiAiCompatibility {
  if (modelProtocol(record) !== OPENAI_COMPLETIONS) return {};
  const endpoint = String(record.endpoint ?? "").toLowerCase();
  const compat: PiAiCompatibility = {};
  if (endpoint.includes("tokenhub.tencentmaas.com")) {
    compat.supportsDeveloperRole = false;
    compat.maxTokensField = "max_tokens";
  }
  if (isTokenHubKimiK3(record)) {
    compat.thinkingFormat = "deepseek";
    compat.requiresReasoningContentOnAssistantMessages = true;
  }
  return compat;
}

function strictApiId(value: unknown): string {
  const original = String(value ?? "");
  if (/^[A-Za-z0-9_-]+$/.test(original)) return original;
  let hash = 0x811c9dc5;
  for (let index = 0; index < original.length; index += 1) {
    hash ^= original.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hint = original.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "item";
  return `hn_${hint}_${hash.toString(16).padStart(8, "0")}`;
}

const RESPONSE_ID_FIELDS = new Set(["id", "item_id", "call_id"]);

export function sanitizeNativeResponseIds(value: unknown): SanitizedNativeResponse {
  let repairs = 0;
  const visit = (input: JsonValue): JsonValue => {
    if (Array.isArray(input)) return input.map(visit);
    if (input === null || typeof input !== "object") return input;
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(input)) {
      if (RESPONSE_ID_FIELDS.has(key) && typeof child === "string") {
        const sanitized = strictApiId(child);
        if (sanitized !== child) repairs += 1;
        output[key] = sanitized;
      } else {
        output[key] = visit(child);
      }
    }
    return output;
  };
  return { value: visit(asJsonValue(value)), repairs };
}

export function sanitizeNativeResponsesBody(body: string): SanitizedNativeResponsesBody {
  const sanitized = sanitizeNativeResponseIds(JSON.parse(body));
  return {
    body: sanitized.repairs > 0 ? JSON.stringify(sanitized.value) : body,
    repairs: sanitized.repairs,
  };
}

function normalizeEndpoint(value: unknown, suffix: "chat/completions" | "responses"): string {
  const text = String(value ?? "").trim();
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)?(?:\?[^#]*)?(?:#.*)?$/i.exec(text);
  if (match === null) throw new Error("model endpoint must be an absolute http(s) URL");
  const protocol = match[1];
  const authority = match[2];
  if (protocol === undefined || authority === undefined) {
    throw new Error("model endpoint must include a protocol and authority");
  }
  let path = String(match[3] ?? "").replace(/\/+$/, "");
  const terminal = /\/(?:chat\/completions|responses)$/i;
  if (terminal.test(path)) {
    path = path.replace(terminal, `/${suffix}`);
  } else {
    if (!path) path = "/v1";
    else if (!/\/v\d+(?:beta)?$/i.test(path)) path += "/v1";
    path += `/${suffix}`;
  }
  return `${protocol.toLowerCase()}://${authority}${path}`;
}

export function normalizeChatCompletionsEndpoint(value: unknown): string {
  return normalizeEndpoint(value, "chat/completions");
}

export function normalizeResponsesEndpoint(value: unknown): string {
  return normalizeEndpoint(value, "responses");
}

export function normalizedModelEndpoint(record: ModelProtocolRecord): string {
  return modelProtocol(record) === OPENAI_RESPONSES
    ? normalizeResponsesEndpoint(record.endpoint)
    : normalizeChatCompletionsEndpoint(record.endpoint);
}
