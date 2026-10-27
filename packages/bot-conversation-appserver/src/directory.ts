import type {
  AppServerClient,
  AppServerClientRegistryService,
} from "@opencraft/appserver-client";
import type {
  AppServerBotDescriptor,
  AppServerBotMethodParams,
} from "@opencraft/appserver-protocol";

import {
  AppServerBotConversationService,
  type HostBotConversationEvent,
} from "./service";

export interface AppServerBotDirectoryEntry {
  readonly hostId: string;
  readonly bot: AppServerBotDescriptor;
  /** Host transport and Bot domain availability reconciled into one projection fact. */
  readonly availability: AppServerBotDescriptor["status"] | "connecting";
}

export interface AppServerBotDirectoryHost {
  readonly hostId: string;
  readonly phase: "connecting" | "loading" | "ready" | "offline" | "unsupported" | "error";
  readonly canManageBots: boolean;
  readonly error: string | null;
}

export interface AppServerBotDirectorySnapshot {
  readonly revision: number;
  readonly entries: readonly AppServerBotDirectoryEntry[];
  readonly hosts: readonly AppServerBotDirectoryHost[];
}

/**
 * One read model for the Bot catalog across every AppServer Host.
 *
 * The directory owns refresh/reconciliation only. Bot identity and mutation
 * remain authoritative on the Host; React merely consumes this external store.
 */
export class AppServerBotDirectory {
  private readonly listeners = new Set<() => void>();
  private readonly entriesByHost = new Map<string, Map<string, AppServerBotDescriptor>>();
  private readonly hostState = new Map<string, AppServerBotDirectoryHost>();
  private readonly statusSubscriptions = new Map<string, () => void>();
  private readonly refreshGeneration = new Map<string, number>();
  private revision = 0;
  private snapshot: AppServerBotDirectorySnapshot = Object.freeze({
    revision: 0,
    entries: Object.freeze([]),
    hosts: Object.freeze([]),
  });
  private readonly stopRegistry: () => void;
  private readonly stopBotEvents: () => void;
  private disposed = false;

  constructor(
    private readonly bots: AppServerBotConversationService,
    private readonly clients: AppServerClientRegistryService,
  ) {
    this.stopRegistry = clients.subscribeEvent((event) => {
      if (event.type === "added") this.observeClient(event.client);
      else this.removeHost(event.hostId);
    });
    this.stopBotEvents = bots.subscribe((event) => this.acceptBotEvent(event));
    for (const client of clients.getAll()) this.observeClient(client);
  }

  getSnapshot = (): AppServerBotDirectorySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh(hostId?: string): Promise<void> {
    if (hostId !== undefined) {
      await this.refreshHost(hostId);
      return;
    }
    await Promise.all(this.clients.getAll().map((client) => this.refreshHost(client.hostId)));
  }

  async create(
    hostId: string,
    params: AppServerBotMethodParams<"bot/create">,
  ): Promise<AppServerBotDescriptor> {
    const client = this.clients.get(hostId);
    const generation = client?.connectionGeneration;
    const capability = await this.bots.waitForCapability(hostId);
    if (!capability.features.botManagement) {
      throw new Error(`Host ${hostId} does not support Bot management`);
    }
    this.assertMutationOwner(hostId, client, generation);
    const receipt = await this.bots.createBot(hostId, params);
    this.assertMutationOwner(hostId, client, generation);
    this.upsert(hostId, receipt.bot);
    await this.refreshHost(hostId);
    return receipt.bot;
  }

  async update(
    hostId: string,
    params: AppServerBotMethodParams<"bot/update">,
  ): Promise<AppServerBotDescriptor> {
    const client = this.clients.get(hostId), generation = client?.connectionGeneration;
    const bot = await this.bots.updateBot(hostId, params);
    this.assertMutationOwner(hostId, client, generation);
    this.upsert(hostId, bot);
    await this.refreshHost(hostId);
    return bot;
  }

  async delete(
    hostId: string,
    params: AppServerBotMethodParams<"bot/delete">,
  ): Promise<void> {
    const client = this.clients.get(hostId), generation = client?.connectionGeneration;
    await this.bots.deleteBot(hostId, params);
    this.assertMutationOwner(hostId, client, generation);
    this.removeBot(hostId, params.botId);
    await this.refreshHost(hostId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRegistry();
    this.stopBotEvents();
    for (const stop of this.statusSubscriptions.values()) stop();
    this.statusSubscriptions.clear();
    this.listeners.clear();
  }

  private assertMutationOwner(hostId: string, client: AppServerClient | null, generation: number | undefined): void {
    if (this.disposed || client === null || this.clients.get(hostId) !== client || client.connectionGeneration !== generation) {
      throw new Error("Bot 操作完成时连接已改变，请刷新当前实例核对结果。");
    }
  }

  private observeClient(client: AppServerClient): void {
    if (this.statusSubscriptions.has(client.hostId)) return;
    const update = () => {
      if (client.status.state === "open") {
        void this.refreshHost(client.hostId);
        return;
      }
      const phase = client.status.state === "idle" || client.status.state === "connecting"
        ? "connecting"
        : client.status.state === "failed"
          ? "error"
          : "offline";
      this.setHost({
        hostId: client.hostId,
        phase,
        canManageBots: false,
        error: client.status.reason ?? null,
      });
    };
    this.statusSubscriptions.set(client.hostId, client.subscribeStatus(update));
    update();
  }

  private async refreshHost(hostId: string): Promise<void> {
    if (this.disposed || this.clients.get(hostId) === null) return;
    const generation = (this.refreshGeneration.get(hostId) ?? 0) + 1;
    this.refreshGeneration.set(hostId, generation);
    this.setHost({ hostId, phase: "loading", canManageBots: false, error: null });
    try {
      const capability = await this.bots.waitForCapability(hostId);
      const descriptors: AppServerBotDescriptor[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.bots.listBots(hostId, {
          limit: capability.limits.maxPageSize,
          ...(cursor === undefined ? {} : { cursor }),
        });
        descriptors.push(...page.data);
        if (page.nextCursor === undefined) {
          cursor = undefined;
          break;
        }
        if (seenCursors.has(page.nextCursor)) {
          throw new Error(`Host ${hostId} returned a repeated bot/list cursor`);
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (this.isCurrent(hostId, generation));
      if (!this.isCurrent(hostId, generation)) return;
      this.entriesByHost.set(hostId, new Map(descriptors.map((bot) => [bot.botId, bot])));
      this.hostState.set(hostId, {
        hostId,
        phase: "ready",
        canManageBots: capability.features.botManagement,
        error: null,
      });
      this.publish();
    } catch (error) {
      if (!this.isCurrent(hostId, generation)) return;
      const unsupported = this.clients.get(hostId)?.initializeResult !== null && !this.bots.supports(hostId);
      this.setHost({
        hostId,
        phase: unsupported ? "unsupported" : "error",
        canManageBots: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private acceptBotEvent(event: HostBotConversationEvent): void {
    if (event.method === "bot/updated") {
      this.upsert(event.hostId, event.params.bot);
      return;
    }
    if (event.method === "bot/deleted") this.removeBot(event.hostId, event.params.botId);
  }

  private upsert(hostId: string, bot: AppServerBotDescriptor): void {
    const entries = this.entriesByHost.get(hostId) ?? new Map<string, AppServerBotDescriptor>();
    const current = entries.get(bot.botId);
    if (current !== undefined && current.revision > bot.revision) return;
    this.refreshGeneration.set(hostId, (this.refreshGeneration.get(hostId) ?? 0) + 1);
    entries.set(bot.botId, bot);
    this.entriesByHost.set(hostId, entries);
    this.publish();
  }

  private removeBot(hostId: string, botId: string): void {
    this.refreshGeneration.set(hostId, (this.refreshGeneration.get(hostId) ?? 0) + 1);
    const entries = this.entriesByHost.get(hostId);
    if (entries?.delete(botId)) this.publish();
  }

  private removeHost(hostId: string): void {
    this.refreshGeneration.set(hostId, (this.refreshGeneration.get(hostId) ?? 0) + 1);
    this.statusSubscriptions.get(hostId)?.();
    this.statusSubscriptions.delete(hostId);
    this.entriesByHost.delete(hostId);
    this.hostState.delete(hostId);
    this.publish();
  }

  private setHost(host: AppServerBotDirectoryHost): void {
    const current = this.hostState.get(host.hostId);
    if (
      current?.phase === host.phase
      && current.canManageBots === host.canManageBots
      && current.error === host.error
    ) return;
    this.hostState.set(host.hostId, host);
    this.publish();
  }

  private isCurrent(hostId: string, generation: number): boolean {
    return !this.disposed
      && this.refreshGeneration.get(hostId) === generation
      && this.clients.get(hostId) !== null;
  }

  private publish(): void {
    const entries = [...this.entriesByHost.entries()]
      .flatMap(([hostId, bots]) => {
        const phase = this.hostState.get(hostId)?.phase;
        return [...bots.values()].map((bot) => ({
          hostId,
          bot,
          availability: phase === "ready"
            ? bot.status
            : phase === "loading" || phase === "connecting"
              ? "connecting" as const
              : "unavailable" as const,
        }));
      })
      .sort((left, right) => left.bot.name.localeCompare(right.bot.name) || left.hostId.localeCompare(right.hostId));
    this.snapshot = Object.freeze({
      revision: ++this.revision,
      entries: Object.freeze(entries),
      hosts: Object.freeze([...this.hostState.values()].sort((a, b) => a.hostId.localeCompare(b.hostId))),
    });
    for (const listener of this.listeners) listener();
  }
}
