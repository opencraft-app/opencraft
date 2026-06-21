import type {
  AgentConfigPatchWire,
  BackendKindWire,
  BackendProbeResultWire,
  BackendWireResponse,
  BackendsWireResponse,
  ClientInputPart,
  CommandAckWire,
  CancelSessionInput,
  ConversationWindowOptions,
  ConversationWireView,
  CreateSessionInput,
  CreateSessionWireResponse,
  DiffReviewWireView,
  PendingRequestsOptions,
  PendingRequestsWireView,
  SendSessionInputEventsInput,
  SessionWireResponse,
  UpdateAgentConfigWireResponse,
  VeladClientOptions,
} from "./wire";
import { createConfigIdempotencyKey, createIdempotencyKey, createSessionIdempotencyKey } from "./idempotency";
import {
  encodeBackendKind,
  encodeSessionId,
  normalizeBaseUrl,
  readBackendProbeResponse,
  readBackendResponse,
  readBackendsResponse,
  readCommandAckResponse,
  readConversationViewResponse,
  readCreateSessionResponse,
  readDiffReviewViewResponse,
  readPendingRequestsViewResponse,
  readSessionResponse,
  readUpdateAgentConfigResponse,
  validateAfterId,
  validateAgentConfigPatch,
  validateClientInputEvents,
  validateConversationWindowOptions,
  validateCreateSessionInput,
  validateOptionalIdempotencyKey,
  validatePendingRequestsOptions,
  validateSendSessionEventsOptions,
} from "./wire-contract";

export interface VeladClient {
  createSession: (input: CreateSessionInput) => Promise<CreateSessionWireResponse>;
  getSession: (sessionId: string) => Promise<SessionWireResponse>;
  getBackends: () => Promise<BackendsWireResponse>;
  getBackend: (backend: BackendKindWire) => Promise<BackendWireResponse>;
  probeBackend: (backend: BackendKindWire) => Promise<BackendProbeResultWire>;
  updateAgentConfig: (input: {
    sessionId: string;
    patch: AgentConfigPatchWire;
    idempotencyKey?: string;
  }) => Promise<UpdateAgentConfigWireResponse>;
  conversationUrl: (sessionId: string, options?: ConversationWindowOptions) => URL;
  requestsUrl: (sessionId: string, options?: PendingRequestsOptions) => URL;
  diffsUrl: (sessionId: string) => URL;
  sessionEventStreamUrl: (sessionId: string, afterId?: string | null) => URL;
  getConversation: (
    sessionId: string,
    options?: ConversationWindowOptions,
  ) => Promise<ConversationWireView>;
  getRequests: (
    sessionId: string,
    options?: PendingRequestsOptions,
  ) => Promise<PendingRequestsWireView>;
  getPendingRequests: (
    sessionId: string,
    options?: PendingRequestsOptions,
  ) => Promise<PendingRequestsWireView>;
  getDiffs: (sessionId: string) => Promise<DiffReviewWireView>;
  cancelSession: (input: CancelSessionInput) => Promise<CommandAckWire>;
  sendSessionInputEvents: (input: SendSessionInputEventsInput) => Promise<CommandAckWire>;
  sendUserMessage: (input: {
    sessionId: string;
    text?: string;
    content?: ClientInputPart[];
    idempotencyKey?: string;
  }) => Promise<CommandAckWire>;
}

export function createVeladClient(options: VeladClientOptions): VeladClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const doFetch = options.fetch ?? fetch;

  const postSessionInputEvents = async ({
    sessionId,
    events,
    idempotencyKey,
    options: requestOptions,
  }: SendSessionInputEventsInput) => {
    validateClientInputEvents(events);
    validateSendSessionEventsOptions(requestOptions);
    const url = new URL(`sessions/${encodeSessionId(sessionId)}/events`, baseUrl);
    const headerIdempotencyKey = validateOptionalIdempotencyKey(idempotencyKey) ?? createIdempotencyKey();
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": headerIdempotencyKey,
      },
      body: JSON.stringify({
        events,
        ...(requestOptions !== undefined ? { options: requestOptions } : {}),
      }),
    });
    return readCommandAckResponse(response);
  };

  return {
    async createSession(input) {
      validateCreateSessionInput(input);
      const idempotencyKey = validateOptionalIdempotencyKey(input.idempotencyKey) ?? createSessionIdempotencyKey();
      const url = new URL("sessions", baseUrl);
      const body: Record<string, unknown> = {
        backend: input.backend,
        working_directory: input.workingDirectory,
      };
      if (input.title) body.title = input.title;
      if (input.model) body.model = input.model;
      if (input.agentConfig) body.agent_config = input.agentConfig;
      if (input.metadata) body.metadata = input.metadata;

      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      return readCreateSessionResponse(response);
    },
    async getSession(sessionId) {
      const url = new URL(`sessions/${encodeSessionId(sessionId)}`, baseUrl);
      const response = await doFetch(url);
      return readSessionResponse(response);
    },
    async getBackends() {
      const url = new URL("backends", baseUrl);
      const response = await doFetch(url);
      return readBackendsResponse(response);
    },
    async getBackend(backend) {
      const url = new URL(`backends/${encodeBackendKind(backend)}`, baseUrl);
      const response = await doFetch(url);
      return readBackendResponse(response);
    },
    async probeBackend(backend) {
      const url = new URL(`backends/${encodeBackendKind(backend)}/probe`, baseUrl);
      const response = await doFetch(url, { method: "POST" });
      return readBackendProbeResponse(response);
    },
    async updateAgentConfig({ sessionId, patch, idempotencyKey }) {
      validateAgentConfigPatch(patch);
      const headerIdempotencyKey = validateOptionalIdempotencyKey(idempotencyKey) ?? createConfigIdempotencyKey();
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/agent-config`, baseUrl);
      const response = await doFetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": headerIdempotencyKey,
        },
        body: JSON.stringify(patch),
      });
      return readUpdateAgentConfigResponse(response);
    },
    conversationUrl(sessionId, options) {
      validateConversationWindowOptions(options);
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/views/conversation`, baseUrl);
      if (options?.limit !== undefined) url.searchParams.set("limit", String(options.limit));
      if (options?.direction) url.searchParams.set("direction", options.direction);
      if (options?.anchorItemId) url.searchParams.set("anchor_item_id", options.anchorItemId);
      return url;
    },
    requestsUrl(sessionId, options) {
      validatePendingRequestsOptions(options);
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/views/requests`, baseUrl);
      if (options?.status) url.searchParams.set("status", options.status);
      return url;
    },
    diffsUrl(sessionId) {
      return new URL(`sessions/${encodeSessionId(sessionId)}/views/diffs`, baseUrl);
    },
    sessionEventStreamUrl(sessionId, afterId) {
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/events/stream`, baseUrl);
      const validAfterId = validateAfterId(afterId);
      if (validAfterId) url.searchParams.set("after_id", validAfterId);
      return url;
    },
    async getConversation(sessionId, options) {
      const response = await doFetch(this.conversationUrl(sessionId, options));
      return readConversationViewResponse(response);
    },
    async getRequests(sessionId, options) {
      const response = await doFetch(this.requestsUrl(sessionId, options));
      return readPendingRequestsViewResponse(response);
    },
    async getPendingRequests(sessionId, options) {
      return this.getRequests(sessionId, options);
    },
    async getDiffs(sessionId) {
      const response = await doFetch(this.diffsUrl(sessionId));
      return readDiffReviewViewResponse(response);
    },
    async cancelSession({ sessionId, idempotencyKey }) {
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/cancel`, baseUrl);
      const headerIdempotencyKey = validateOptionalIdempotencyKey(idempotencyKey) ?? createIdempotencyKey();
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "Idempotency-Key": headerIdempotencyKey,
        },
      });
      return readCommandAckResponse(response);
    },
    async sendSessionInputEvents(input) {
      return postSessionInputEvents(input);
    },
    async sendUserMessage({ sessionId, text, content, idempotencyKey }) {
      const messageContent = content ?? (text ? [{ type: "text", text } as const] : []);
      return postSessionInputEvents({
        sessionId,
        idempotencyKey,
        events: [
          {
            type: "user.message",
            content: messageContent,
          },
        ],
      });
    },
  };
}
