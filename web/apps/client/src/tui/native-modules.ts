import {
  PlatformApi,
  PlatformError,
  type ConversationSummary,
  type ConversationSummarySnapshot,
  type CredentialStore,
  type ConversationAddress,
  type HumanImSession,
  type Message,
  type MessagePage,
  type MessageReference,
  type MessageSearchPage,
  type MessagingLifecycleEvent,
  type MessagingScope,
  type ReconcileMessageInput,
  type ReconcileMessageResult,
  type SearchMessagesInput,
  type SendAttachmentInput,
  type SendTaskInput,
  type SendTextInput,
  type Unsubscribe,
} from "@vela/client-core";

const nativePlatformBaseURL = "https://native.invalid/v1";

export interface NativeModulesBridge {
  call(
    module: string,
    method: string,
    payload: unknown,
    options: {deadlineMs?: number; requestId: string},
  ): Promise<unknown>;
  protocol: string;
  subscribe(
    module: string,
    topic: string,
    payload: unknown,
    options: {launchId: string; subscriptionId: string},
  ): string;
  unsubscribe(subscriptionId: string): void;
}

interface NativeErrorEnvelope {
  code?: unknown;
  message?: unknown;
  providerCode?: unknown;
  requestId?: unknown;
  retryable?: unknown;
}

export interface NativeModuleEvent {
  kind: string;
  launchId?: string;
  payload?: unknown;
  sequence?: number;
  subscriptionId: string;
}

export class NativeMessagingPort {
  private readonly launchID = `tui-launch-${Date.now()}`;
  private nextRequestID = 1;
  private nextSubscriptionID = 1;
  private readonly subscriptions = new Map<
    string,
    (payload: unknown) => void
  >();

  public constructor(private readonly bridge: NativeModulesBridge) {}

  public async close(): Promise<void> {
    await this.invoke("close", {});
  }

  public async connect(_session: HumanImSession): Promise<void> {
    await this.connectFresh();
  }

  public async connectFresh(): Promise<void> {
    await this.invoke("connect", {launchId: this.launchID});
  }

  public async loadHistory(
    channel: ConversationAddress,
    cursor?: string,
  ): Promise<MessagePage> {
    try {
      return (await this.bridge.call(
        "messaging.v1",
        "loadHistory",
        {channel, ...(cursor ? {cursor} : {})},
        {deadlineMs: 30_000, requestId: this.requestID()},
      )) as MessagePage;
    } catch (error) {
      const envelope = nativeEnvelope(error);
      if (
        !("directConversationId" in channel) &&
        envelope.providerCode === "sdk_10007"
      ) {
        throw new PlatformError("IM_NOT_MEMBER", "当前账号不在 Channel Topic 中", {
          platformCode: envelope.providerCode,
          ...(envelope.requestId ? {requestId: envelope.requestId} : {}),
        });
      }
      throw nativePlatformError(envelope);
    }
  }

  public loadMessageContext(
    channel: ConversationAddress,
    reference: MessageReference,
  ): Promise<Message[]> {
    return this.invoke("loadMessageContext", {channel, reference});
  }

  public listConversations(
    groupIds: string[],
  ): Promise<ConversationSummarySnapshot> {
    return this.invoke("listConversations", {groupIds});
  }

  public loadMessagesByReferences(
    channel: ConversationAddress,
    references: MessageReference[],
  ): Promise<Message[]> {
    return this.invoke("loadMessagesByReferences", {channel, references});
  }

  public async markRead(channel: ConversationAddress): Promise<void> {
    await this.invoke("markRead", {channel});
  }

  public async reconcileMessage(
    _input: ReconcileMessageInput,
  ): Promise<ReconcileMessageResult> {
    return {state: "pending"};
  }

  public async setScope(scope: MessagingScope): Promise<void> {
    await this.invoke("setScope", {
      allowedConversations: scope.allowedConversations,
      allowedMemberImUserIds: [],
      generation: scope.generation,
    });
  }

  public async retryMessage(_clientRequestId: string): Promise<Message> {
    throw new PlatformError("IM_REJECTED", "TUI 暂不支持重发本地消息草稿");
  }

  public revokeMessage(messageId: string): Promise<Message> {
    return this.invoke("revokeMessage", {messageId});
  }

  public searchMessages(input: SearchMessagesInput): Promise<MessageSearchPage> {
    return this.invoke("searchMessages", input);
  }

  public sendTask(input: SendTaskInput): Promise<Message> {
    return this.invoke("sendTask", input);
  }

  public sendAttachment(input: SendAttachmentInput): Promise<Message> {
    if (input.source.kind !== "uri") {
      return Promise.reject(
        new PlatformError("USAGE", "TUI 附件必须使用本机文件路径"),
      );
    }
    return this.invoke("sendAttachment", {
      ...input,
      source: {
        kind: input.source.kind,
        mimeType: input.source.mimeType,
        name: input.source.name,
        uri: input.source.uri,
      },
    });
  }

  public sendText(input: SendTextInput): Promise<Message> {
    return this.invoke("sendText", input);
  }

  public async setReaction(
    messageId: string,
    reactionId: string,
    active: boolean,
  ): Promise<void> {
    await this.invoke("setReaction", {active, messageId, reactionId});
  }

  public subscribeConversations(
    listener: (conversations: ConversationSummary[]) => void,
  ): Unsubscribe {
    return this.subscribe("conversations", (payload) =>
      listener(Array.isArray(payload) ? (payload as ConversationSummary[]) : []),
    );
  }

  public subscribeLifecycle(
    listener: (event: MessagingLifecycleEvent) => void,
  ): Unsubscribe {
    return this.subscribe("lifecycle", (payload) =>
      listener(payload as MessagingLifecycleEvent),
    );
  }

  public subscribeMessages(
    listener: (messages: Message[]) => void,
  ): Unsubscribe {
    return this.subscribe("messages", (payload) =>
      listener(Array.isArray(payload) ? (payload as Message[]) : []),
    );
  }

  public async waitUntilReady(timeoutMs: number): Promise<void> {
    await this.invoke("waitUntilReady", {timeoutMs});
  }

  public dispatchNativeEvent(event: NativeModuleEvent): void {
    if (event.kind !== "event") return;
    this.subscriptions.get(event.subscriptionId)?.(event.payload);
  }

  private subscribe(
    topic: string,
    listener: (payload: unknown) => void,
  ): Unsubscribe {
    const subscriptionId = `tui-subscription-${this.nextSubscriptionID++}`;
    this.subscriptions.set(subscriptionId, listener);
    this.bridge.subscribe("messaging.v1", topic, {}, {
      launchId: this.launchID,
      subscriptionId,
    });
    return () => {
      if (!this.subscriptions.delete(subscriptionId)) return;
      this.bridge.unsubscribe(subscriptionId);
    };
  }

  private async invoke<T>(method: string, payload: unknown): Promise<T> {
    try {
      return (await this.bridge.call("messaging.v1", method, payload, {
        deadlineMs: 30_000,
        requestId: this.requestID(),
      })) as T;
    } catch (error) {
      throw nativePlatformError(nativeEnvelope(error));
    }
  }

  private requestID(): string {
    return `tui-request-${this.nextRequestID++}`;
  }
}

class NativeCredentialStore implements CredentialStore {
  private token: string | null = "native-session";

  public async clear(): Promise<void> {
    this.token = null;
  }

  public async loadRefreshToken(): Promise<string | null> {
    return this.token;
  }

  public async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  public async saveRefreshToken(_token: string): Promise<void> {
    this.token = "native-session";
  }
}

export function createNativePlatformPort(
  bridge: NativeModulesBridge,
): PlatformApi {
  let nextRequestID = 1;
  const call = (method: string, payload: unknown) =>
    bridge.call("platform.v1", method, payload, {
      deadlineMs: 30_000,
      requestId: `tui-platform-${nextRequestID++}`,
    });
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = inputURL(input);
    if (!url.startsWith(nativePlatformBaseURL)) {
      return nativeResponse(400, {
        error: {code: "invalid_native_url", message: "Native URL 无效"},
      });
    }
    const path = url.slice(nativePlatformBaseURL.length) || "/";
    const method = (init.method ?? "GET").toUpperCase();
    const body = parseBody(init.body);
    try {
      if (path === "/auth/login" && method === "POST") {
        const credentials = record(body);
        const account = await call("login", {
          email: credentials.email,
          password: credentials.password,
        });
        return nativeResponse(200, nativeSession(account));
      }
      if (path === "/auth/register" && method === "POST") {
        const account = await call("register", body);
        return nativeResponse(200, nativeSession(account));
      }
      if (path === "/auth/refresh" && method === "POST") {
        const account = await call("restore", {});
        return nativeResponse(200, nativeSession(account));
      }
      if (path === "/auth/logout" && method === "POST") {
        await call("logout", {});
        return nativeResponse(204, null);
      }
      const value = await call("request", {
        body,
        headers: requestHeaders(init.headers),
        method,
        path,
      });
      return nativeResponse(200, value);
    } catch (error) {
      const envelope = nativeEnvelope(error);
      return nativeResponse(nativeStatus(envelope.code), {
        error: {
          code: envelope.providerCode ?? envelope.code,
          message: envelope.message,
          ...(envelope.requestId ? {requestId: envelope.requestId} : {}),
        },
      });
    }
  };
  return new PlatformApi({
    baseUrl: nativePlatformBaseURL,
    credentials: new NativeCredentialStore(),
    fetcher,
  });
}

function nativeEnvelope(error: unknown): {
  code: string;
  message: string;
  providerCode?: string;
  requestId?: string;
} {
  const value =
    typeof error === "object" && error !== null
      ? (error as NativeErrorEnvelope)
      : {};
  return {
    code: typeof value.code === "string" ? value.code : "NATIVE_CALL_FAILED",
    message:
      typeof value.message === "string" ? value.message : "Native 调用失败",
    ...(typeof value.providerCode === "string"
      ? {providerCode: value.providerCode}
      : {}),
    ...(typeof value.requestId === "string" ? {requestId: value.requestId} : {}),
  };
}

function nativePlatformError(
  envelope: ReturnType<typeof nativeEnvelope>,
): PlatformError {
  return new PlatformError("PROTOCOL", envelope.message, {
    platformCode: envelope.providerCode ?? envelope.code,
    ...(envelope.requestId ? {requestId: envelope.requestId} : {}),
  });
}

function inputURL(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null && "url" in input) {
    return String(input.url);
  }
  return String(input);
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string" || body.length === 0) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function nativeSession(account: unknown) {
  return {
    accessToken: "native-access",
    account,
    expiresAt: "2099-01-01T00:00:00Z",
    refreshToken: "native-refresh",
  };
}

function requestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  let values: Record<string, string>;
  if (Array.isArray(headers)) values = Object.fromEntries(headers);
  else if (typeof headers === "object" && "forEach" in headers) {
    values = {};
    (headers as Headers).forEach((value, key) => {
      values[key] = value;
    });
  } else {
    values = {...(headers as Record<string, string>)};
  }
  const allowed: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (
      name.toLowerCase() === "idempotency-key" ||
      name.toLowerCase() === "x-resource-revision"
    ) {
      allowed[name] = value;
    }
  }
  return allowed;
}

function nativeResponse(status: number, value: unknown): Response {
  const text = value === null || value === undefined ? "" : JSON.stringify(value);
  return {
    clone: () => nativeResponse(status, value),
    headers: {get: () => null},
    json: async () => value,
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

function nativeStatus(code: string): number {
  if (code === "AUTH_REQUIRED") return 401;
  if (code === "AUTH_FORBIDDEN") return 403;
  if (code === "RESOURCE_NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  if (code === "RATE_LIMITED") return 429;
  if (code === "USAGE") return 422;
  if (code === "REMOTE_UNAVAILABLE") return 503;
  return 500;
}
