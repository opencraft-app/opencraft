import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { IncomingMessage } from "node:http";
import {
  HttpBodyTooLarge,
  jsonResponse,
  type HttpExchangeRequest,
  type HttpExchangeResponse,
} from "@opencraft/http-exchange";
import { parseInputCompletion, type InputCompletion } from "@opencraft/appserver-protocol";
import {
  encodeConversationRef,
  parseConversationRef,
  type ConversationRef,
} from "@opencraft/appserver-protocol/collaboration";
import type {
  ExternalConversationRequest,
  ExternalConversationResult,
} from "@opencraft/access-control/external-conversation";

export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_RPC_PATH = "/api/a2a";
export const A2A_BODY_LIMIT = 65_536;
export const A2A_MAX_ACTIVE = 16;
export interface A2aConfiguration {
  origin: string;
  actorId: string;
  ref: ConversationRef;
  name: string;
  description: string;
  version: string;
}
export interface A2aPorts {
  conversation(
    input: Omit<ExternalConversationRequest, "hostId">,
  ): Promise<ExternalConversationResult & { completion?: InputCompletion }>;
}
type ObjectValue = Record<string, unknown>;
type TaskState = "submitted" | "working" | "completed" | "failed" | "canceled" | "unknown";
type Task = {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState };
  artifacts?: {
    artifactId: string;
    parts: { kind: "text"; text: string }[];
    metadata?: { truncated: true };
  }[];
};
const record = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const sessionId = new RegExp(`^session://${uuid}/${uuid}$`, "u");
const taskId = new RegExp(`^${uuid}$`, "u");
const headers = [
  ["cache-control", "no-store"],
  ["x-content-type-options", "nosniff"],
] as const;
const response = (status: number, body: unknown, extra: [string, string][] = []) =>
  jsonResponse(status, body, [["content-type", "application/json"], ...headers, ...extra]);
const rpcError = (id: string | number | null, code: number, message: string, data?: { taskId: string }) =>
  response(200, { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });

export function a2aOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("A2A requires a canonical HTTPS origin");
  const url = new URL(value);
  if (url.protocol !== "https:" || value !== url.origin) throw new Error("A2A requires a canonical HTTPS origin");
  return url.origin;
}
export function actorBearer(value: unknown): string | null {
  return typeof value === "string" && /^Bearer oc_actor_[A-Za-z0-9_.-]{1,246}$/iu.test(value) ? value.slice(7) : null;
}
export function duplicateAuthorization(raw: readonly string[]): boolean {
  return raw.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "authorization").length > 1;
}
export function parseA2aConfiguration(value: unknown): A2aConfiguration {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !["origin", "actorId", "conversation", "name", "description", "version"].includes(key),
    ) ||
    typeof value.actorId !== "string" ||
    !sessionId.test(value.actorId) ||
    typeof value.conversation !== "string"
  )
    throw new Error("Invalid A2A configuration");
  const ref = parseConversationRef(value.conversation);
  if (!ref) throw new Error("A2A requires a conversation reference");
  const text = (input: unknown, fallback: string) => {
    if (input === undefined) return fallback;
    if (typeof input !== "string" || !input.trim() || input.length > 512 || /[\x00-\x1f]/u.test(input))
      throw new Error("Invalid A2A description");
    return input;
  };
  return {
    origin: a2aOrigin(value.origin),
    actorId: value.actorId,
    ref,
    name: text(value.name, "OpenCraft"),
    description: text(value.description, "Send text requests to an authorized agent conversation."),
    version: text(value.version, "1.0.0"),
  };
}

/** Explicit trusted server plugin. The core owns credentials, grants, durable inputs and completion evidence. */
export function createA2aPlugin(
  configuration: A2aConfiguration,
  ports: A2aPorts,
  timing: { waitMs?: number; pollMs?: number } = {},
) {
  // Reparse at the public boundary so callers cannot accidentally bypass configuration validation.
  const { ref, ...values } = configuration;
  const config = parseA2aConfiguration({ ...values, conversation: encodeConversationRef(ref) });
  const waitMs = timing.waitMs ?? 8_000,
    pollMs = timing.pollMs ?? 750;
  if (
    !Number.isInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > 8_000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 750
  )
    throw new Error("Invalid A2A wait budget");
  const namespace = "a2a." + hash([config.origin, config.actorId, config.ref]).slice(0, 32);
  const contextId = hash([namespace, config.actorId]);
  const card = {
    protocolVersion: "0.3.0",
    name: config.name,
    description: config.description,
    version: config.version,
    url: config.origin + A2A_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
    skills: [
      {
        id: "text-conversation",
        name: "Agent conversation",
        description: config.description,
        tags: ["conversation"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
      },
    ],
  };
  const lifetime = new AbortController();
  const jobs = new Set<Promise<HttpExchangeResponse | null>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  function task(value: Extract<ExternalConversationResult, { kind: "task" }> & { completion?: InputCompletion }): Task {
    const receipt = value.receipt;
    const completion = parseInputCompletion(value.completion, receipt.targetTurnId);
    const delivery: Record<string, TaskState> = {
      accepted: "submitted",
      transferring: "submitted",
      queued: "submitted",
      submitted: "working",
      injected: "working",
      rejected: "failed",
      cancelled: "canceled",
    };
    const state =
      completion && completion.status !== "unknown"
        ? completion.status === "interrupted"
          ? "failed"
          : completion.status
        : (delivery[receipt.deliveryState] ?? "unknown");
    return {
      kind: "task",
      id: receipt.requestId,
      contextId,
      status: { state },
      ...(state === "completed" && completion?.text
        ? {
            artifacts: [
              {
                artifactId: receipt.requestId,
                parts: [{ kind: "text", text: completion.text }],
                ...(completion.truncated ? { metadata: { truncated: true as const } } : {}),
              },
            ],
          }
        : {}),
    };
  }
  async function handle(request: HttpExchangeRequest<IncomingMessage>): Promise<HttpExchangeResponse | null> {
    if (request.path !== AGENT_CARD_PATH && request.path !== A2A_RPC_PATH) return null;
    if (closed) return response(503, {});
    if (request.path === AGENT_CARD_PATH) {
      if (request.method === "HEAD") return { ...response(200, card), body: null };
      return request.method === "GET" ? response(200, card) : response(405, {}, [["allow", "GET, HEAD"]]);
    }
    if (request.method !== "POST") return response(405, {}, [["allow", "POST"]]);
    const bearer = actorBearer(request.headers.authorization);
    if (!bearer || duplicateAuthorization(request.rawHeaders))
      return response(401, {}, [["www-authenticate", "Bearer"]]);
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return response(415, {});
    const signal = AbortSignal.any([request.signal, lifetime.signal]);
    let input: unknown;
    const bodyTimeout = AbortSignal.timeout(10_000);
    const abortBody = () => request.identity.destroy();
    bodyTimeout.addEventListener("abort", abortBody, { once: true });
    signal.addEventListener("abort", abortBody, { once: true });
    try {
      signal.throwIfAborted();
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await request.readBody(A2A_BODY_LIMIT)));
    } catch (error) {
      if (signal.aborted) throw error;
      return error instanceof HttpBodyTooLarge ? response(413, {}) : rpcError(null, -32700, "Parse error");
    } finally {
      bodyTimeout.removeEventListener("abort", abortBody);
      signal.removeEventListener("abort", abortBody);
    }
    if (
      !record(input) ||
      input.jsonrpc !== "2.0" ||
      typeof input.method !== "string" ||
      !(
        (typeof input.id === "string" && input.id.length <= 128) ||
        (typeof input.id === "number" && Number.isSafeInteger(input.id))
      )
    )
      return rpcError(null, -32600, "Invalid request");
    const id = input.id,
      method = input.method;
    if (!record(input.params)) return rpcError(id, -32602, "Invalid params");
    const params = input.params;
    const invoke = (operation: ExternalConversationRequest["operation"]) => {
      signal.throwIfAborted();
      return ports.conversation({ actorId: config.actorId, bearer, ref: config.ref, namespace, operation });
    };
    const project = (value: Awaited<ReturnType<A2aPorts["conversation"]>>) => {
      signal.throwIfAborted();
      if (value.kind === "task") return response(200, { jsonrpc: "2.0", id, result: task(value) });
      if (value.kind === "authentication") return response(401, {}, [["www-authenticate", "Bearer"]]);
      if (value.kind === "denied") return response(403, {});
      if (value.kind === "missing") return rpcError(id, -32001, "Task not found");
      if (value.kind === "conflict") return rpcError(id, -32602, "Message ID is already in use");
      return rpcError(id, -32603, "Agent execution is temporarily unavailable");
    };
    try {
      if (method === "tasks/get" || method === "tasks/cancel") {
        if (
          typeof params.id !== "string" ||
          !taskId.test(params.id) ||
          (params.historyLength !== undefined &&
            (!Number.isSafeInteger(params.historyLength) || Number(params.historyLength) < 0))
        )
          return rpcError(id, -32602, "Invalid params");
        const current = await invoke({ kind: "status", id: params.id });
        return method === "tasks/cancel" && current.kind === "task"
          ? rpcError(id, -32002, "Task cannot be canceled")
          : project(current);
      }
      if (method.startsWith("tasks/pushNotificationConfig/"))
        return rpcError(id, -32003, "Push Notification is not supported");
      if (method !== "message/send") return rpcError(id, -32601, "Method not found");
      const message = params.message,
        configuration = params.configuration;
      if (
        !record(message) ||
        message.kind !== "message" ||
        message.role !== "user" ||
        typeof message.messageId !== "string" ||
        !message.messageId.trim() ||
        message.messageId.length > 256 ||
        message.taskId !== undefined ||
        (message.contextId !== undefined && message.contextId !== contextId) ||
        !Array.isArray(message.parts) ||
        !message.parts.length ||
        message.parts.length > 128 ||
        (configuration !== undefined && !record(configuration))
      )
        return rpcError(id, -32602, "Invalid params");
      if (message.parts.some((part) => !record(part) || part.kind !== "text" || typeof part.text !== "string"))
        return rpcError(id, -32005, "Only text parts are supported");
      const content = message.parts.map((part) => (part as { text: string }).text).join("\n");
      if (!content.trim() || content.length > 16_384 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(content))
        return rpcError(id, -32602, "Invalid params");
      const sendConfig = configuration as ObjectValue | undefined;
      if (sendConfig?.blocking !== undefined && typeof sendConfig.blocking !== "boolean")
        return rpcError(id, -32602, "Invalid params");
      if (sendConfig?.pushNotificationConfig !== undefined)
        return rpcError(id, -32003, "Push Notification is not supported");
      if (
        sendConfig?.acceptedOutputModes !== undefined &&
        (!Array.isArray(sendConfig.acceptedOutputModes) || !sendConfig.acceptedOutputModes.includes("text/plain"))
      )
        return rpcError(id, -32005, "Only text/plain output is supported");
      const sent = await invoke({ kind: "send", key: hash(message.messageId), content });
      if (sent.kind !== "task" || sendConfig?.blocking === false) return project(sent);
      const deadline = performance.now() + waitMs;
      let current = sent;
      const pending = (value: typeof sent) => ["submitted", "working", "unknown"].includes(task(value).status.state);
      while (performance.now() < deadline && pending(current)) {
        await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())), undefined, { signal });
        const next = await invoke({ kind: "status", id: sent.receipt.requestId });
        if (next.kind !== "task") return project(next);
        current = next;
      }
      if (sendConfig?.blocking === true && pending(current))
        return rpcError(id, -32010, "Task is still running", { taskId: sent.receipt.requestId });
      return project(current);
    } catch (error) {
      if (signal.aborted) throw error;
      return rpcError(id, -32603, "Agent execution is temporarily unavailable");
    }
  }
  return {
    paths: new Set([AGENT_CARD_PATH, A2A_RPC_PATH]),
    handle(request: HttpExchangeRequest<IncomingMessage>): Promise<HttpExchangeResponse | null> {
      if (request.path !== AGENT_CARD_PATH && request.path !== A2A_RPC_PATH) return Promise.resolve(null);
      if (jobs.size >= A2A_MAX_ACTIVE) return Promise.resolve(response(429, {}, [["retry-after", "2"]]));
      const job = handle(request);
      jobs.add(job);
      void job.finally(() => jobs.delete(job)).catch(() => {});
      return job;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      lifetime.abort();
      closing = Promise.allSettled([...jobs]).then(() => {});
      return closing;
    },
  };
}
