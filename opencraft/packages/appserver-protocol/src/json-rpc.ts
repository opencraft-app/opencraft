export type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcEnvelope {
  jsonrpc?: "2.0";
}

export interface JsonRpcRequest<TParams = unknown> extends JsonRpcEnvelope {
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> extends JsonRpcEnvelope {
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> extends JsonRpcEnvelope {
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcFailure extends JsonRpcEnvelope {
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccess<TResult>
  | JsonRpcFailure;

export type JsonRpcIncomingMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export class JsonRpcParseError extends SyntaxError {
  readonly code = -32700;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JsonRpcParseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function parseErrorObject(value: unknown): JsonRpcErrorObject | null {
  if (!isRecord(value) || typeof value.code !== "number" || typeof value.message !== "string") {
    return null;
  }
  return {
    code: value.code,
    message: value.message,
    ...(hasOwn(value, "data") ? { data: value.data } : {}),
  };
}

/**
 * Parses the Codex AppServer JSON-RPC dialect. The server accepts envelopes
 * both with and without the optional `jsonrpc: "2.0"` marker.
 */
export function parseJsonRpcMessage(frame: string): JsonRpcIncomingMessage {
  let value: unknown;
  try {
    value = JSON.parse(frame) as unknown;
  } catch (error) {
    throw new JsonRpcParseError("AppServer sent malformed JSON", { cause: error });
  }

  if (!isRecord(value)) {
    throw new JsonRpcParseError("AppServer JSON-RPC frame must be an object");
  }
  if (value.jsonrpc !== undefined && value.jsonrpc !== "2.0") {
    throw new JsonRpcParseError("Unsupported JSON-RPC version");
  }

  const envelope = value.jsonrpc === "2.0" ? { jsonrpc: "2.0" as const } : {};
  if (typeof value.method === "string") {
    const params = hasOwn(value, "params") ? { params: value.params } : {};
    if (hasOwn(value, "id")) {
      if (!isJsonRpcId(value.id)) {
        throw new JsonRpcParseError("JSON-RPC request id must be a string or number");
      }
      return { ...envelope, id: value.id, method: value.method, ...params };
    }
    return { ...envelope, method: value.method, ...params };
  }

  if (!hasOwn(value, "id") || (value.id !== null && !isJsonRpcId(value.id))) {
    throw new JsonRpcParseError("JSON-RPC response is missing a valid id");
  }
  if (hasOwn(value, "error")) {
    const error = parseErrorObject(value.error);
    if (error === null) throw new JsonRpcParseError("Invalid JSON-RPC error response");
    return { ...envelope, id: value.id, error };
  }
  if (!hasOwn(value, "result") || value.id === null) {
    throw new JsonRpcParseError("Invalid JSON-RPC success response");
  }
  return { ...envelope, id: value.id, result: value.result };
}

export function encodeJsonRpcMessage(message: JsonRpcIncomingMessage): string {
  return JSON.stringify(message);
}

export function isJsonRpcRequest(message: JsonRpcIncomingMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isJsonRpcNotification(
  message: JsonRpcIncomingMessage,
): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isJsonRpcFailure(message: JsonRpcIncomingMessage): message is JsonRpcFailure {
  return "error" in message;
}

export function isJsonRpcSuccess(message: JsonRpcIncomingMessage): message is JsonRpcSuccess {
  return "result" in message;
}
