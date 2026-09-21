import { Context, Service, type Fiber } from "@deepseek-ai/cordis";
import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";

import { ReplicaClient, type ReplicaClientConfig } from "./client";
import type { ReplicaClientStorage } from "./storage";

declare module "@deepseek-ai/cordis" {
  interface Context {
    appserverReplicas: ReplicaRegistryService;
  }
}

export interface ReplicaRegistryConfig {
  storage: ReplicaClientStorage;
}

export class ReplicaRegistryService extends Service {
  private readonly storage: ReplicaClientStorage;
  private readonly clients = new Map<string, ReplicaClient>();

  constructor(ctx: Context, config: ReplicaRegistryConfig) {
    super(ctx, "appserverReplicas");
    this.storage = config.storage;
    ctx.effect(() => () => {
      for (const client of this.clients.values()) client.dispose();
      this.clients.clear();
    });
  }

  create(config: Omit<ReplicaClientConfig, "storage">): ReplicaClient {
    if (this.clients.has(config.scope)) throw new Error(`Replica ${config.scope} is already registered`);
    const client = new ReplicaClient({ ...config, storage: this.storage });
    this.clients.set(config.scope, client);
    return client;
  }

  get(scope: string): ReplicaClient | null {
    return this.clients.get(scope) ?? null;
  }

  remove(scope: string): boolean {
    const client = this.clients.get(scope);
    if (client === undefined) return false;
    client.dispose();
    this.clients.delete(scope);
    return true;
  }

  list(): readonly ReplicaClient[] {
    return [...this.clients.values()];
  }
}

export interface CordisReplicaRuntime {
  readonly context: Context;
  readonly replicas: ReplicaRegistryService;
  dispose(): Promise<void>;
}

export async function createCordisReplicaRuntime(
  storage: ReplicaClientStorage<ReplicaJsonValue>,
): Promise<CordisReplicaRuntime> {
  const context = new Context();
  const fiber: Fiber = context.plugin(ReplicaRegistryService, { storage });
  await fiber;
  return {
    context,
    replicas: context.appserverReplicas,
    async dispose() {
      await fiber.dispose();
    },
  };
}
