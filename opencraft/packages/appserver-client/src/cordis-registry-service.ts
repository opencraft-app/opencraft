import { Context, Service, type Fiber } from "@deepseek-ai/cordis";

import type { AppServerClientConfig, AppServerClient } from "./client";
import {
  AppServerClientRegistry,
  type AppServerClientRegistryEvent,
  type AppServerClientRegistrySnapshot,
} from "./registry";

declare module "@deepseek-ai/cordis" {
  interface Context {
    appServerClients: AppServerClientRegistryService;
  }
}

/** Cordis-owned multi-host registry; disposal closes every physical link. */
export class AppServerClientRegistryService extends Service {
  private readonly registry = new AppServerClientRegistry();

  constructor(ctx: Context) {
    super(ctx, "appServerClients");
    ctx.effect(() => () => this.registry.close());
  }

  getSnapshot = (): AppServerClientRegistrySnapshot => this.registry.getSnapshot();
  subscribe = (listener: () => void): (() => void) => this.registry.subscribe(listener);

  subscribeEvent(listener: (event: AppServerClientRegistryEvent) => void): () => void {
    return this.registry.subscribeEvent(listener);
  }

  create(config: AppServerClientConfig): AppServerClient {
    return this.registry.create(config);
  }

  get(hostId: string): AppServerClient | null {
    return this.registry.get(hostId);
  }

  getOrThrow(hostId: string): AppServerClient {
    return this.registry.getOrThrow(hostId);
  }

  getAll(): readonly AppServerClient[] {
    return this.registry.getAll();
  }

  remove(hostId: string): Promise<boolean> {
    return this.registry.remove(hostId);
  }

  close(): Promise<void> {
    return this.registry.close();
  }
}

export interface CordisAppServerRegistryRuntime {
  readonly context: Context;
  readonly fiber: Fiber;
  readonly clients: AppServerClientRegistryService;
  dispose(): Promise<void>;
}

export async function createCordisAppServerRegistry(
  context: Context = new Context(),
): Promise<CordisAppServerRegistryRuntime> {
  const fiber = context.plugin(AppServerClientRegistryService);
  await fiber;
  return {
    context,
    fiber,
    clients: context.appServerClients,
    dispose: () => fiber.dispose(),
  };
}
