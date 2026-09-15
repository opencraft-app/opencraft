import type {
  Account,
  AcceptedResource,
  Channel,
  DirectConversationResource,
  CreateDirectConversationResult,
  HumanImSession,
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
    return this.account.requestRaw<CollaborationServerPage>(collaborationPath("/servers"), {
      method: "GET",
    });
  }

  createHumanImSession(): Promise<HumanImSession> {
    return this.account.requestRaw<HumanImSession>(collaborationPath("/me/im/session"), {
      method: "POST",
    });
  }

  getMe(): Promise<Account> {
    return this.account.requestRaw<Account>(collaborationPath("/me"), { method: "GET" });
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
    return this.account.requestRaw<CollaborationComputer>(
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
    return this.account.requestRaw<readonly Channel[]>(
      collaborationPath(`/servers/${encodeURIComponent(serverId)}/channels`),
      { method: "GET" },
    );
  }

  listMembers(serverId: string): Promise<readonly Member[]> {
    return this.drainCursor<Member>(
      collaborationPath(`/servers/${encodeURIComponent(serverId)}/members`),
    );
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
    const value = await this.account.requestRaw<DirectConversationResource | AcceptedResource>(
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

  private async drainCursor<T>(path: string): Promise<readonly T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const suffix: string = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
      const page: CursorPage<T> = await this.account.requestRaw<CursorPage<T>>(`${path}${suffix}`, {
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
