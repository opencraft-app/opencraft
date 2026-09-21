import type { Account } from "@lightvela/vela-chat-client-core";
import type {
	CollaborationComputer,
  CollaborationServer,
  CollaborationServerPage,
} from "./collaboration-client";

export type CollaborationWorkspacePhase = "idle" | "loading" | "ready" | "error";

export interface CollaborationWorkspaceSnapshot {
  readonly phase: CollaborationWorkspacePhase;
  readonly account: Account | null;
  readonly servers: readonly CollaborationServer[];
  readonly availableInstances: readonly LightVelaInstanceCandidate[];
	readonly computersByServer: Readonly<Record<string, readonly CollaborationComputer[]>>;
  readonly error: string | null;
  readonly revision: number;
}

export interface CollaborationServerClient {
  getMe(): Promise<Account>;
  listServers(): Promise<CollaborationServerPage>;
	listComputersV2(serverId: string): Promise<readonly CollaborationComputer[]>;
	attachComputerV2(serverId: string, instanceId: string, name: string | null, idempotencyKey: string): Promise<CollaborationComputer>;
}

export interface LightVelaInstanceCandidate {
  readonly instanceId: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface LightVelaInstanceDirectoryPort {
  listInstances(): Promise<readonly LightVelaInstanceCandidate[]>;
}

export interface CollaborationMessagingOwner {
  connect(): Promise<void>;
  dispose(): Promise<void>;
}

export class CollaborationWorkspaceService {
  private readonly listeners = new Set<() => void>();
  private loadOperation: Promise<void> | null = null;
  private disposeOperation: Promise<void> | null = null;
  private disposed = false;
  private generation = 0;
  private snapshot: CollaborationWorkspaceSnapshot = Object.freeze({
    phase: "idle",
    account: null,
    servers: Object.freeze([]),
    availableInstances: Object.freeze([]),
	computersByServer: Object.freeze({}),
    error: null,
    revision: 0,
  });

  constructor(
    private readonly client: CollaborationServerClient,
    private readonly messaging: CollaborationMessagingOwner,
    private readonly instances: LightVelaInstanceDirectoryPort,
	private readonly computersEnabled = false,
  ) {}

  getSnapshot = (): CollaborationWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  load(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Collaboration workspace service is disposed"));
    }
    if (this.loadOperation !== null) return this.loadOperation;
    const generation = ++this.generation;
    this.publish({ phase: "loading", error: null });
    const operation = Promise.all([
      this.client.listServers(),
      this.client.getMe(),
      this.messaging.connect(),
	  this.computersEnabled ? this.instances.listInstances() : Promise.resolve([]),
    ]).then(async ([page, account, _connected, instances]) => {
      if (this.disposed || generation !== this.generation) return;
      this.publish({
        phase: "ready",
        account,
        servers: Object.freeze([...page.items]),
        availableInstances: Object.freeze([...instances]),
        error: null,
      });
    }).catch((error: unknown) => {
      if (this.disposed || generation !== this.generation) return;
      this.publish({
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (this.loadOperation === operation) this.loadOperation = null;
    });
    this.loadOperation = operation;
    return operation;
  }

	async loadComputers(serverId: string): Promise<void> {
		if (this.disposed) throw new Error("Collaboration workspace service is disposed");
		if (!this.computersEnabled) return;
		const computers = await this.client.listComputersV2(serverId);
		if (this.disposed) return;
		this.publish({
			computersByServer: Object.freeze({
				...this.snapshot.computersByServer,
				[serverId]: Object.freeze([...computers]),
			}),
		});
	}

	async attachComputer(serverId: string, instanceId: string): Promise<CollaborationComputer> {
		if (this.disposed) throw new Error("Collaboration workspace service is disposed");
		if (!this.computersEnabled) throw new Error("Computer capability is not enabled");
		const created = await this.client.attachComputerV2(
			serverId,
			instanceId,
			null,
			crypto.randomUUID(),
		);
		await this.loadComputers(serverId);
		return created;
	}

  dispose(): Promise<void> {
    if (this.disposeOperation !== null) return this.disposeOperation;
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
    this.disposeOperation = this.messaging.dispose();
    return this.disposeOperation;
  }

  private publish(
    patch: Partial<Omit<CollaborationWorkspaceSnapshot, "revision">>,
  ): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      revision: this.snapshot.revision + 1,
    });
    this.listeners.forEach((listener) => listener());
  }
}
