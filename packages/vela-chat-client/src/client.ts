import type {
  AgentConfigPatchWire,
  ArchiveSessionInput,
  ArchiveSessionWireResponse,
  BackendKindWire,
  BackendProbeResultWire,
  BackendSettingsPatchWire,
  BackendSettingsWireResponse,
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
  SessionListOptions,
  SessionListViewWireResponse,
  SessionListWireResponse,
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
  readBackendSettingsResponse,
  readBackendResponse,
  readBackendsResponse,
  readCommandAckResponse,
  readConversationViewResponse,
  readCreateSessionResponse,
  readDiffReviewViewResponse,
  readPendingRequestsViewResponse,
  readSessionListViewResponse,
  readSessionListResponse,
  readSessionResponse,
  readArchiveSessionResponse,
  readUpdateAgentConfigResponse,
  validateAfterId,
  validateAgentConfigPatch,
  validateBackendSettingsPatch,
  validateClientInputEvents,
  validateConversationWindowOptions,
  validateCreateSessionInput,
  validateOptionalIdempotencyKey,
  validatePendingRequestsOptions,
  validateSendSessionEventsOptions,
  validateSessionListOptions,
} from "./wire-contract";

export interface VeladClient {
  listSessions: (options?: SessionListOptions) => Promise<SessionListWireResponse>;
  getSessionListView: (options?: SessionListOptions) => Promise<SessionListViewWireResponse>;
  createSession: (input: CreateSessionInput) => Promise<CreateSessionWireResponse>;
  archiveSession: (input: ArchiveSessionInput) => Promise<ArchiveSessionWireResponse>;
  getSession: (sessionId: string) => Promise<SessionWireResponse>;
  getBackends: () => Promise<BackendsWireResponse>;
  getBackend: (backend: BackendKindWire) => Promise<BackendWireResponse>;
  probeBackend: (backend: BackendKindWire) => Promise<BackendProbeResultWire>;
  getBackendSettings: (backend: BackendKindWire) => Promise<BackendSettingsWireResponse>;
  updateBackendSettings: (
    backend: BackendKindWire,
    patch: BackendSettingsPatchWire,
  ) => Promise<BackendSettingsWireResponse>;
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
  const observability = options.observability;

  const observedFetch = async (
    name: string,
    url: URL,
    init: RequestInit = {},
    attributes: Record<string, string | number | boolean> = {},
  ) => {
    const span = observability?.startSpan(name, {
      attributes: {
        "http.method": init.method ?? "GET",
        "http.url": url.toString(),
        "velad.api_base_url": baseUrl.toString(),
        ...attributes,
      },
    });
    const headers = headersRecord(init.headers);
    if (span && observability) {
      headers.traceparent = observability.traceparent(span);
    }
    try {
      const response = await doFetch(url, {
        ...init,
        headers,
      });
      span?.setAttribute("http.status_code", response.status);
      if (!response.ok) {
        span?.setStatus({
          code: 2,
          message: `HTTP ${response.status}`,
        });
      } else {
        span?.setStatus({ code: 1 });
      }
      return response;
    } catch (err) {
      if (span && observability) {
        observability.recordError(span, err);
        void observability.emitLog?.({
          severityText: "ERROR",
          body: errorMessage(err),
          span,
          attributes: {
            "http.method": init.method ?? "GET",
            "http.url": url.toString(),
            "vela.operation": name,
            ...attributes,
          },
        });
      }
      throw err;
    } finally {
      span?.end();
    }
  };

  const headersRecord = (headers: HeadersInit | undefined): Record<string, string> => {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return { ...headers };
  };

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
    const response = await observedFetch("velad.session.send_events", url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": headerIdempotencyKey,
      },
      body: JSON.stringify({
        events,
        ...(requestOptions !== undefined ? { options: requestOptions } : {}),
      }),
    }, {
      "velad.session_id": sessionId,
      "velad.input_events": events.length,
    });
    return readCommandAckResponse(response);
  };

  return {
    async listSessions(options) {
      validateSessionListOptions(options);
      const url = new URL("sessions", baseUrl);
      if (options?.limit !== undefined) url.searchParams.set("limit", String(options.limit));
      if (options?.afterId) url.searchParams.set("after_id", options.afterId);
      const response = await observedFetch("velad.sessions.list", url);
      return readSessionListResponse(response);
    },
    async getSessionListView(options) {
      validateSessionListOptions(options);
      const url = new URL("views/sessions", baseUrl);
      if (options?.limit !== undefined) url.searchParams.set("limit", String(options.limit));
      if (options?.afterId) url.searchParams.set("after_id", options.afterId);
      const response = await observedFetch("velad.session_list_view.get", url);
      return readSessionListViewResponse(response);
    },
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

      const response = await observedFetch("velad.session.create", url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      }, {
        "velad.backend": input.backend,
        "velad.working_directory": input.workingDirectory,
      });
      return readCreateSessionResponse(response);
    },
    async getSession(sessionId) {
      const url = new URL(`sessions/${encodeSessionId(sessionId)}`, baseUrl);
      const response = await observedFetch("velad.session.get", url, {}, { "velad.session_id": sessionId });
      return readSessionResponse(response);
    },
    async archiveSession({ sessionId }) {
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/archive`, baseUrl);
      const response = await observedFetch("velad.session.archive", url, { method: "POST" }, { "velad.session_id": sessionId });
      return readArchiveSessionResponse(response);
    },
    async getBackends() {
      const url = new URL("backends", baseUrl);
      const response = await observedFetch("velad.backends.list", url);
      return readBackendsResponse(response);
    },
    async getBackend(backend) {
      const url = new URL(`backends/${encodeBackendKind(backend)}`, baseUrl);
      const response = await observedFetch("velad.backend.get", url, {}, { "velad.backend": backend });
      return readBackendResponse(response);
    },
    async probeBackend(backend) {
      const url = new URL(`backends/${encodeBackendKind(backend)}/probe`, baseUrl);
      const response = await observedFetch("velad.backend.probe", url, { method: "POST" }, { "velad.backend": backend });
      return readBackendProbeResponse(response);
    },
    async getBackendSettings(backend) {
      const url = new URL(`backends/${encodeBackendKind(backend)}/settings`, baseUrl);
      const response = await observedFetch("velad.backend.settings.get", url, {}, { "velad.backend": backend });
      return readBackendSettingsResponse(response);
    },
    async updateBackendSettings(backend, patch) {
      validateBackendSettingsPatch(patch);
      const url = new URL(`backends/${encodeBackendKind(backend)}/settings`, baseUrl);
      const response = await observedFetch("velad.backend.settings.update", url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(patch),
      }, { "velad.backend": backend });
      return readBackendSettingsResponse(response);
    },
    async updateAgentConfig({ sessionId, patch, idempotencyKey }) {
      validateAgentConfigPatch(patch);
      const headerIdempotencyKey = validateOptionalIdempotencyKey(idempotencyKey) ?? createConfigIdempotencyKey();
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/agent-config`, baseUrl);
      const response = await observedFetch("velad.session.agent_config.update", url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": headerIdempotencyKey,
        },
        body: JSON.stringify(patch),
      }, {
        "velad.session_id": sessionId,
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
      const response = await observedFetch("velad.conversation.get", this.conversationUrl(sessionId, options), {}, { "velad.session_id": sessionId });
      return readConversationViewResponse(response);
    },
    async getRequests(sessionId, options) {
      const response = await observedFetch("velad.requests.get", this.requestsUrl(sessionId, options), {}, { "velad.session_id": sessionId });
      return readPendingRequestsViewResponse(response);
    },
    async getPendingRequests(sessionId, options) {
      return this.getRequests(sessionId, options);
    },
    async getDiffs(sessionId) {
      const response = await observedFetch("velad.diffs.get", this.diffsUrl(sessionId), {}, { "velad.session_id": sessionId });
      return readDiffReviewViewResponse(response);
    },
    async cancelSession({ sessionId, idempotencyKey }) {
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/cancel`, baseUrl);
      const headerIdempotencyKey = validateOptionalIdempotencyKey(idempotencyKey) ?? createIdempotencyKey();
      const response = await observedFetch("velad.session.cancel", url, {
        method: "POST",
        headers: {
          "Idempotency-Key": headerIdempotencyKey,
        },
      }, {
        "velad.session_id": sessionId,
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
