import type {
  HumanProfile,
  AcceptedResource,
  Channel,
  DirectConversationResource,
  CreateDirectConversationResult,
  HumanImSession,
  InviteSecret,
  JoinResult,
  Member,
} from "@lightvela/vela-chat-client-core";

export interface LightVelaAccountRequestPort {
  requestRaw<T>(path: string, init?: RequestInit): Promise<T>;
}

export interface CollaborationServer {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string | null;
  readonly ownerMemberId: string;
  readonly imState: "provisioning" | "ready" | "error";
  readonly revision: number;
}

export interface CollaborationServerPage {
  readonly items: readonly CollaborationServer[];
  readonly nextCursor: string | null;
}

export type CollaborationServerCreateResult =
  | { readonly kind: "ready"; readonly resource: CollaborationServer }
  | { readonly kind: "accepted"; readonly accepted: AcceptedResource };

export interface CollaborationComputer {
  readonly id: string;
  readonly serverId: string;
  readonly kind: "lightvela_instance";
  readonly instanceId: string;
  readonly name: string;
  readonly lifecycleState: "attaching" | "active" | "removed";
  readonly observedState:
    | "creating"
    | "running"
    | "paused"
    | "isolating"
    | "deleting"
    | "deleted"
    | "failed"
    | "unknown";
  readonly lastObservedAt?: string | null;
  readonly lastErrorCode?: string | null;
  readonly revision: number;
  readonly createdAt: string;
}

interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | null;
}

const COLLABORATION_API_PREFIX = "/v1/collaboration";

function collaborationPath(path: string): string {
  return `${COLLABORATION_API_PREFIX}${path}`;
}

export class CollaborationClient {
  constructor(private readonly account: LightVelaAccountRequestPort) {}

  listServers(): Promise<CollaborationServerPage> {
    return this.request<CollaborationServerPage>(collaborationPath("/servers"), {
      method: "GET",
    });
  }

  getServer(serverId: string): Promise<CollaborationServer> {
    return this.request<CollaborationServer>(
      collaborationPath(`/servers/${encodeURIComponent(serverId)}`),
      { method: "GET" },
    );
  }

  async createServer(
    name: string,
    slug: string,
    idempotencyKey: string,
  ): Promise<CollaborationServerCreateResult> {
    const value = await this.request<CollaborationServer | AcceptedResource>(
      collaborationPath("/servers"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ name, slug }),
      },
    );
    return "resourceId" in value
      ? { kind: "accepted", accepted: value }
      : { kind: "ready", resource: value };
  }

  async createHumanImSession(): Promise<HumanImSession> {
    const result = await this.request<unknown>(collaborationPath("/me/im/session"), {
      method: "POST",
    });
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("IM 会话响应无效，请稍后重试。");
    }
    const session = result as Partial<HumanImSession>;
    if (typeof session.sdkAppId !== "number" || session.sdkAppId <= 0 ||
      typeof session.userId !== "string" || !session.userId ||
      typeof session.userSig !== "string" || !session.userSig ||
      typeof session.expiresAt !== "string") {
      throw new Error("IM 会话响应无效，请稍后重试。");
    }
    return session as HumanImSession;
  }

  async getMe(): Promise<HumanProfile> {
    const result = await this.request<unknown>(collaborationPath("/me/profile"), { method: "GET" });
    if (result === null || typeof result !== "object" || Array.isArray(result) ||
      typeof (result as Partial<HumanProfile>).id !== "string" ||
      typeof (result as Partial<HumanProfile>).displayName !== "string") {
      throw new Error("协作账户响应无效，请稍后重试。");
    }
    return result as HumanProfile;
  }

  listComputersV2(serverId: string): Promise<readonly CollaborationComputer[]> {
    return this.drainCursor<CollaborationComputer>(
      collaborationPath(`/servers/${encodeURIComponent(serverId)}/computers-v2`),
    );
  }

  attachComputerV2(
    serverId: string,
    instanceId: string,
    name: string | null,
    idempotencyKey: string,
  ): Promise<CollaborationComputer> {
    return this.request<CollaborationComputer>(
      collaborationPath(`/servers/${encodeURIComponent(serverId)}/computers-v2`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          kind: "lightvela_instance",
          instanceId,
          ...(name?.trim() ? { name: name.trim() } : {}),
        }),
      },
    );
  }

  listChannels(serverId: string): Promise<readonly Channel[]> {
    return this.request<readonly Channel[]>(
      collaborationPath(`/servers/${encodeURIComponent(serverId)}/channels`),
      { method: "GET" },
    );
  }

  listMembers(serverId: string): Promise<readonly Member[]> {
    return this.drainCursor<Member>(
      collaborationPath(`/servers/${encodeURIComponent(serverId)}/members`),
    );
  }

  async createInvite(serverId: string, expiresAt: string): Promise<InviteSecret> {
    const result = await this.request<unknown>(
      collaborationPath(`/servers/${encodeURIComponent(serverId)}/invites`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "member", maxUses: 1, expiresAt }),
      },
    );
    if (result === null || typeof result !== "object" || Array.isArray(result) ||
      typeof (result as Partial<InviteSecret>).token !== "string" ||
      !(result as InviteSecret).token ||
      typeof (result as Partial<InviteSecret>).invite?.id !== "string") {
      throw new Error("邀请响应无效，请稍后重试。");
    }
    return result as InviteSecret;
  }

  async acceptJoinLink(token: string, idempotencyKey: string): Promise<JoinResult> {
    const result = await this.request<unknown>(collaborationPath("/join-links/accept"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ token }),
    });
    if (result === null || typeof result !== "object" || Array.isArray(result) ||
      typeof (result as Partial<JoinResult>).serverId !== "string" ||
      !(result as JoinResult).serverId) {
      throw new Error("加入响应无效，请保留邀请令牌并重试。");
    }
    return result as JoinResult;
  }

  listDirectConversations(
    serverId: string,
  ): Promise<readonly DirectConversationResource[]> {
    return this.drainCursor<DirectConversationResource>(
      collaborationPath(`/servers/${encodeURIComponent(serverId)}/direct-conversations`),
    );
  }

  async createDirectConversation(
    serverId: string,
    peerMemberId: string,
    idempotencyKey: string,
  ): Promise<CreateDirectConversationResult> {
    const value = await this.request<DirectConversationResource | AcceptedResource>(
      collaborationPath(`/servers/${encodeURIComponent(serverId)}/direct-conversations`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ peerMemberId }),
      },
    );
    return "memberA" in value
      ? { kind: "ready", resource: value }
      : { kind: "accepted", accepted: value };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.account.requestRaw<unknown>(path, init);
    if (response !== null && typeof response === "object" && "error" in response) {
      const error = response.error;
      if (error !== null && typeof error === "object" && "code" in error &&
        typeof error.code === "string") {
        throw new Error("协作服务返回错误，请稍后重试。");
      }
    }
    return response as T;
  }

  private async drainCursor<T>(path: string): Promise<readonly T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const suffix: string = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
      const page: CursorPage<T> = await this.request<CursorPage<T>>(`${path}${suffix}`, {
        method: "GET",
      });
      items.push(...page.items);
      const next: string | null = page.nextCursor?.trim() || null;
      if (next !== null) {
        if (seen.has(next)) throw new Error("Collaboration cursor loop detected");
        seen.add(next);
      }
      cursor = next;
      if (items.length > 10_000) throw new Error("Collaboration list exceeds client safety limit");
    } while (cursor !== null);
    return items;
  }
}
