import {
  channelAddress,
  directAddress,
  type Channel,
  type CreateDirectConversationResult,
  type DirectConversationResource,
  type Member,
  type MessagingScope,
} from "@lightvela/vela-chat-client-core";

export interface ImDirectoryClient {
  createDirectConversation(
    serverId: string,
    peerMemberId: string,
    idempotencyKey: string,
  ): Promise<CreateDirectConversationResult>;
  listChannels(serverId: string): Promise<readonly Channel[]>;
  listMembers(serverId: string): Promise<readonly Member[]>;
  listDirectConversations(serverId: string): Promise<readonly DirectConversationResource[]>;
}

export interface ImScopeOwner {
  setScope(scope: MessagingScope): Promise<void>;
}

export interface ImDirectorySnapshot {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly serverId: string | null;
  readonly channels: readonly Channel[];
  readonly directConversations: readonly DirectConversationResource[];
  readonly members: readonly Member[];
  readonly error: string | null;
  readonly revision: number;
}

export interface ImDirectoryServiceOptions {
  readonly createRequestId?: () => string;
}

export class ImDirectoryService {
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private readonly createRequestId: () => string;
  private loadOperation: Promise<void> | null = null;
  private loadingServerId: string | null = null;
  private snapshot: ImDirectorySnapshot = Object.freeze({
    phase: "idle",
    serverId: null,
    channels: Object.freeze([]),
    directConversations: Object.freeze([]),
    members: Object.freeze([]),
    error: null,
    revision: 0,
  });

  constructor(
    private readonly client: ImDirectoryClient,
    private readonly scopeOwner: ImScopeOwner,
    options: ImDirectoryServiceOptions = {},
  ) {
    this.createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
  }

  getSnapshot = (): ImDirectorySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  load(serverId: string): Promise<void> {
    const normalized = serverId.trim();
    if (!normalized) return Promise.reject(new RangeError("Server ID must not be empty"));
    if (this.loadOperation !== null && this.loadingServerId === normalized) {
      return this.loadOperation;
    }
    const generation = ++this.generation;
    this.loadingServerId = normalized;
    this.publish({
      phase: "loading",
      serverId: normalized,
      channels: Object.freeze([]),
      directConversations: Object.freeze([]),
      members: Object.freeze([]),
      error: null,
    });
    const operation = Promise.all([
      this.client.listChannels(normalized),
      this.client.listDirectConversations(normalized),
      this.client.listMembers(normalized),
    ]).then(async ([channels, directConversations, members]) => {
      if (generation !== this.generation) return;
      await this.applyScope(generation, channels, directConversations);
      if (generation !== this.generation) return;
      this.publish({
        phase: "ready",
        serverId: normalized,
        channels: Object.freeze([...channels]),
        directConversations: Object.freeze([...directConversations]),
        members: Object.freeze([...members]),
        error: null,
      });
    }).catch((error: unknown) => {
      if (generation !== this.generation) return;
      this.publish({
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (this.loadOperation === operation) {
        this.loadOperation = null;
        this.loadingServerId = null;
      }
    });
    this.loadOperation = operation;
    return operation;
  }

  async startPrivateConversation(memberId: string): Promise<string | null> {
    const normalized = memberId.trim();
    const { serverId, directConversations, channels, phase } = this.snapshot;
    if (!normalized || serverId === null || phase !== "ready") return null;
    const existing = directConversations.find(
      (conversation) => conversation.memberA.id === normalized || conversation.memberB.id === normalized,
    );
    if (existing !== undefined) return existing.id;
    const result = await this.client.createDirectConversation(
      serverId,
      normalized,
      this.createRequestId(),
    );
    if (result.kind === "accepted") return null;
    const next = Object.freeze([...directConversations, result.resource]);
    const generation = ++this.generation;
    await this.applyScope(generation, channels, next);
    this.publish({ directConversations: next, error: null });
    return result.resource.id;
  }

  private applyScope(
    generation: number,
    channels: readonly Channel[],
    directConversations: readonly DirectConversationResource[],
  ): Promise<void> {
    const allowedConversations = [
      ...channels.map(channelAddress),
      ...directConversations.map((conversation) => directAddress({
        directConversationId: conversation.id,
        imGroupId: conversation.imGroupId,
        imState: conversation.imState,
      })),
    ].filter((address): address is NonNullable<typeof address> => address !== null);
    return this.scopeOwner.setScope({ generation, allowedConversations });
  }

  private publish(patch: Partial<Omit<ImDirectorySnapshot, "revision">>): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      revision: this.snapshot.revision + 1,
    });
    this.listeners.forEach((listener) => listener());
  }
}
