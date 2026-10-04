import type { HumanProfile, InviteSecret, JoinResult } from "@lightvela/vela-chat-client-core";
import type {
	CollaborationComputer,
  CollaborationServer,
  CollaborationServerCreateResult,
  CollaborationServerPage,
} from "./collaboration-client";

export type CollaborationWorkspacePhase = "idle" | "loading" | "ready" | "error";

export interface CollaborationWorkspaceSnapshot {
  readonly phase: CollaborationWorkspacePhase;
  readonly account: HumanProfile | null;
  readonly servers: readonly CollaborationServer[];
  readonly availableInstances: readonly LightVelaInstanceCandidate[];
	readonly computersByServer: Readonly<Record<string, readonly CollaborationComputer[]>>;
  readonly error: string | null;
  readonly errorKind: "authentication" | "general" | null;
  readonly revision: number;
}

export interface CollaborationServerClient {
  getMe(): Promise<HumanProfile>;
  listServers(): Promise<CollaborationServerPage>;
	getServer(serverId: string): Promise<CollaborationServer>;
	createServer(name: string, slug: string, idempotencyKey: string): Promise<CollaborationServerCreateResult>;
	createInvite(serverId: string, expiresAt: string): Promise<InviteSecret>;
	acceptJoinLink(token: string, idempotencyKey: string): Promise<JoinResult>;
	listComputersV2(serverId: string): Promise<readonly CollaborationComputer[]>;
	attachComputerV2(serverId: string, instanceId: string, name: string | null, idempotencyKey: string): Promise<CollaborationComputer>;
}

interface ServerCreationAttempt {
  readonly name: string;
  readonly slug: string;
  readonly idempotencyKey: string;
}

interface JoinAttempt {
  readonly token: string;
  readonly idempotencyKey: string;
}

function serverSlug(name: string, idempotencyKey: string): string {
  const suffix = idempotencyKey.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  const base = name.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54)
    .replace(/-+$/g, "") || "server";
  return `${base}-${suffix}`;
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
  private createAttempt: ServerCreationAttempt | null = null;
  private createOperation: Promise<string> | null = null;
  private joinAttempt: JoinAttempt | null = null;
  private joinOperation: Promise<string> | null = null;
  private snapshot: CollaborationWorkspaceSnapshot = Object.freeze({
    phase: "idle",
    account: null,
    servers: Object.freeze([]),
    availableInstances: Object.freeze([]),
	computersByServer: Object.freeze({}),
    error: null,
    errorKind: null,
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
    this.publish({ phase: "loading", error: null, errorKind: null });
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
        errorKind: null,
      });
    }).catch((error: unknown) => {
      if (this.disposed || generation !== this.generation) return;
      this.publish({
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
        errorKind: error !== null && typeof error === "object" &&
          "status" in error && error.status === 401
          ? "authentication"
          : "general",
      });
    }).finally(() => {
      if (this.loadOperation === operation) this.loadOperation = null;
    });
    this.loadOperation = operation;
    return operation;
  }

  createServer(name: string): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("Collaboration workspace service is disposed"));
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 100) {
      return Promise.reject(new RangeError("Server name must be 1–100 characters"));
    }
    if (this.createOperation !== null) return this.createOperation;
    if (this.createAttempt !== null && this.createAttempt.name !== normalizedName) {
      return Promise.reject(new Error("请先确认上一次 Server 创建结果，再修改名称。"));
    }
    const attempt = this.createAttempt ?? (() => {
      const idempotencyKey = crypto.randomUUID();
      return {
        name: normalizedName,
        slug: serverSlug(normalizedName, idempotencyKey),
        idempotencyKey,
      };
    })();
    this.createAttempt = attempt;
    const submitted = this.client.createServer(
      attempt.name,
      attempt.slug,
      attempt.idempotencyKey,
    ).catch((error: unknown) => {
      const status = error !== null && typeof error === "object" && "status" in error
        ? error.status
        : null;
      if (typeof status === "number" && status >= 400 && status < 500 &&
        status !== 408 && status !== 429) {
        this.createAttempt = null;
      }
      throw error;
    });
    const operation = submitted.then(async (result) => {
      if (this.disposed) throw new Error("Collaboration workspace service is disposed");
      const serverId = result.kind === "ready" ? result.resource.id : result.accepted.resourceId;
      const page = await this.client.listServers();
      const server = page.items.find((item) => item.id === serverId) ??
        (result.kind === "ready" ? result.resource : await this.client.getServer(serverId));
      if (this.disposed) throw new Error("Collaboration workspace service is disposed");
      if (!this.disposed) {
        this.publish({
          servers: Object.freeze(
            page.items.some((item) => item.id === serverId)
              ? [...page.items]
              : [...page.items, server],
          ),
          error: null,
          errorKind: null,
        });
      }
      this.createAttempt = null;
      return serverId;
    }).finally(() => {
      if (this.createOperation === operation) this.createOperation = null;
    });
    this.createOperation = operation;
    return operation;
  }

  async createInvite(serverId: string): Promise<string> {
    if (this.disposed) throw new Error("Collaboration workspace service is disposed");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await this.client.createInvite(serverId, expiresAt);
    if (this.disposed) throw new Error("Collaboration workspace service is disposed");
    return result.token;
  }

  acceptJoinLink(token: string): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("Collaboration workspace service is disposed"));
    const normalizedToken = token.trim();
    if (!normalizedToken) return Promise.reject(new Error("请输入邀请令牌"));
    if (this.joinOperation !== null) return this.joinOperation;
    if (this.joinAttempt !== null && this.joinAttempt.token !== normalizedToken) {
      return Promise.reject(new Error("请先确认上一次加入结果，再更换邀请令牌。"));
    }
    const attempt = this.joinAttempt ?? {
      token: normalizedToken,
      idempotencyKey: crypto.randomUUID(),
    };
    this.joinAttempt = attempt;
    const submitted = this.client.acceptJoinLink(attempt.token, attempt.idempotencyKey)
      .catch((error: unknown) => {
        const status = error !== null && typeof error === "object" && "status" in error
          ? error.status : null;
        if (typeof status === "number" && status >= 400 && status < 500 &&
          status !== 408 && status !== 429) {
          this.joinAttempt = null;
        }
        throw error;
      });
    const operation = submitted.then(async (result) => {
      if (this.disposed) throw new Error("Collaboration workspace service is disposed");
      const page = await this.client.listServers();
      const server = page.items.find((item) => item.id === result.serverId) ??
        await this.client.getServer(result.serverId);
      if (this.disposed) throw new Error("Collaboration workspace service is disposed");
      if (!this.disposed) {
        this.publish({
          servers: Object.freeze(page.items.some((item) => item.id === server.id)
            ? [...page.items] : [...page.items, server]),
          error: null,
          errorKind: null,
        });
      }
      this.joinAttempt = null;
      return result.serverId;
    }).finally(() => {
      if (this.joinOperation === operation) this.joinOperation = null;
    });
    this.joinOperation = operation;
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
		if (this.disposed) throw new Error("Collaboration workspace service is disposed");
		return created;
	}

  dispose(): Promise<void> {
    if (this.disposeOperation !== null) return this.disposeOperation;
    this.disposed = true;
    this.generation += 1;
    this.createAttempt = null;
    this.joinAttempt = null;
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
