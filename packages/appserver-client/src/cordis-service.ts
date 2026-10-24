import { Context, Service, type Fiber } from "@deepseek-ai/cordis";
import type {
  AppServerInitializeParams,
  AppServerInitializeResponse,
  AppServerMethod,
  AppServerMethodParams,
  AppServerMethodResult,
  AppServerNotification,
  AppServerRequestOptions,
} from "@opencraft/appserver-protocol";

import {
  JsonRpcAppServerClient,
  type AppServerClient,
  type AppServerClientConfig,
  type AppServerRequestLifecycleEvent,
  type AppServerNotificationInterceptor,
  type AppServerServerRequestInterceptor,
  type ServerRequestHandler,
} from "./client";
import type { TransportStatus } from "./transport";

declare module "@deepseek-ai/cordis" {
  interface Context {
    appServerClient: AppServerClientService;
  }
}

export class AppServerClientService extends Service implements AppServerClient {
  private readonly client: JsonRpcAppServerClient;

  constructor(ctx: Context, config: AppServerClientConfig) {
    super(ctx, "appServerClient");
    this.client = new JsonRpcAppServerClient(config);
    ctx.effect(() => () => this.client.close());
  }

  get hostId(): string {
    return this.client.hostId;
  }

  get status(): TransportStatus {
    return this.client.status;
  }

  get initializeResult(): AppServerInitializeResponse | null {
    return this.client.initializeResult;
  }

  get connectionGeneration(): number {
    return this.client.connectionGeneration;
  }

  connect(params: AppServerInitializeParams, signal?: AbortSignal): Promise<AppServerInitializeResponse> {
    return this.client.connect(params, signal);
  }

  request<TMethod extends AppServerMethod>(
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
    options?: AppServerRequestOptions,
  ): Promise<AppServerMethodResult<TMethod>> {
    return this.client.request(method, params, options);
  }

  requestRaw<TResult = unknown>(
    method: string,
    params: unknown,
    options?: AppServerRequestOptions,
  ): Promise<TResult> {
    return this.client.requestRaw(method, params, options);
  }

  subscribeNotification(listener: (notification: AppServerNotification) => void): () => void {
    return this.client.subscribeNotification(listener);
  }

  interceptNotification(interceptor: AppServerNotificationInterceptor): () => void {
    return this.client.interceptNotification(interceptor);
  }

  interceptServerRequest(interceptor: AppServerServerRequestInterceptor): () => void {
    return this.client.interceptServerRequest(interceptor);
  }

  subscribeProtocolError(listener: (error: Error) => void): () => void {
    return this.client.subscribeProtocolError(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    return this.client.subscribeStatus(listener);
  }

  subscribeRequestLifecycle(listener: (event: AppServerRequestLifecycleEvent) => void): () => void {
    return this.client.subscribeRequestLifecycle(listener);
  }

  getPendingRequestCount(): number {
    return this.client.getPendingRequestCount();
  }

  handleServerRequest(method: string, handler: ServerRequestHandler): () => void {
    return this.client.handleServerRequest(method, handler);
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export interface CordisAppServerClientRuntime {
  readonly context: Context;
  readonly fiber: Fiber;
  readonly client: AppServerClientService;
  dispose(): Promise<void>;
}

export async function createCordisAppServerClient(
  config: AppServerClientConfig,
): Promise<CordisAppServerClientRuntime> {
  const context = new Context();
  const fiber = context.plugin(AppServerClientService, config);
  await fiber;
  return {
    context,
    fiber,
    client: context.appServerClient,
    dispose: () => fiber.dispose(),
  };
}
