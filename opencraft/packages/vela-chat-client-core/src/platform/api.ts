import type {components} from "../generated/openapi.js";
import type {MessageReference} from "../messaging/model.js";
import {normalizeApiBaseUrl} from "./base-url.js";
import {
  PlatformError,
  responseError,
  type StableErrorCode,
} from "./errors.js";
import type {
  EnsureThreadInput,
  MessageThread,
  RegisterThreadReplyInput,
  ThreadReplyReference,
  ThreadReplyReferencePage,
} from "./thread.js";

export type Account = components["schemas"]["Account"];
export type AcceptedResource = components["schemas"]["AcceptedResource"];
export type Agent = components["schemas"]["AgentV2"];
export type AgentProfileCapabilities =
  components["schemas"]["AgentProfileCapabilities"];
type AuthResult = components["schemas"]["AuthResult"];
export type Channel = components["schemas"]["Channel"];
export type Computer = components["schemas"]["Computer"] & {
  assignmentVersion?: number;
};
type ComputerRuntimeCapability =
  components["schemas"]["ComputerRuntimeCapability"];
export type CreateAgentInput = components["schemas"]["CreateAgentRequestV2"];
export type CreateChannelInput = components["schemas"]["CreateChannelRequest"];
export type CreateComputerInput =
  components["schemas"]["CreateComputerRequest"];
export type CreateDirectConversationInput =
  components["schemas"]["CreateDirectConversationRequest"];
export type CreateInviteInput = components["schemas"]["CreateInviteRequest"];
export type CreateReminderInput =
  components["schemas"]["CreateReminderRequest"];
export type CreateServerInput = components["schemas"]["CreateServerRequest"];
export type CreateTaskInput = components["schemas"]["CreateTaskRequest"];
export type HumanImSession = components["schemas"]["ImSession"];
export type InboxItem = components["schemas"]["InboxItem"];
export type Invite = components["schemas"]["Invite"];
export type InviteSecret = components["schemas"]["InviteSecret"];
export type JoinResult = components["schemas"]["JoinResult"];
export type Member = components["schemas"]["Member"];
export type DirectConversationResource =
  components["schemas"]["DirectConversation"];
export type Operation = components["schemas"]["Operation"];
export type RegisterInput = components["schemas"]["RegisterRequest"];
export interface RegistrationScript {
  computerId: string;
  expiresAt: string;
  revision: number;
  script: string;
}
export type Reminder = components["schemas"]["Reminder"];
export type Server = components["schemas"]["Server"];
export type Task = components["schemas"]["Task"];
export type TerminalSession = components["schemas"]["TerminalSession"];
export type ActivityItem = components["schemas"]["ActivityItem"];
export type UpdateMemberInput = components["schemas"]["UpdateMemberRequest"];
export type UpdateAgentInput = components["schemas"]["UpdateAgentRequestV2"];
export type UpdateChannelInput =
  components["schemas"]["UpdateChannelRequest"];
export type UpdateReminderInput =
  components["schemas"]["UpdateReminderRequest"];
export type UpdateServerInput = components["schemas"]["UpdateServerRequest"];
export type UpdateTaskInput = components["schemas"]["UpdateTaskRequest"];

export type CreateServerResult =
  | {kind: "ready"; resource: Server}
  | {accepted: AcceptedResource; kind: "accepted"};

export type CreateDirectConversationResult =
  | {kind: "ready"; resource: DirectConversationResource}
  | {accepted: AcceptedResource; kind: "accepted"};

export interface CredentialStore {
  clear(): Promise<void>;
  loadRefreshToken(): Promise<string | null>;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  saveRefreshToken(token: string): Promise<void>;
}

interface PlatformApiOptions {
  baseUrl: string;
  credentials: CredentialStore;
  fetcher?: typeof fetch;
  now?: () => Date;
}

interface LogoutResult {
  remoteRevoked: boolean;
  warnings: Array<{code: StableErrorCode; message: string}>;
}

export class PlatformApi {
  private readonly baseUrl: string;
  private readonly credentials: CredentialStore;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private accessToken: string | null = null;
  private accessExpiresAt = 0;
  private refreshPromise: Promise<void> | null = null;

  public constructor(options: PlatformApiOptions) {
    this.baseUrl = normalizeApiBaseUrl(options.baseUrl);
    this.credentials = options.credentials;
    const fetcher = options.fetcher ?? fetch;
    this.fetcher = (input, init) => fetcher(input, init);
    this.now = options.now ?? (() => new Date());
  }

  public async restore(): Promise<Account> {
    await this.refreshAccess();
    return this.getMe();
  }

  public async login(email: string, password: string): Promise<Account> {
    return this.credentials.runExclusive(async () => {
      const session = await this.publicJson<AuthResult>("/auth/login", {
        body: JSON.stringify({email, password}),
        headers: {"Content-Type": "application/json"},
        method: "POST",
      });
      assertAuthResult(session);
      await this.adoptSession(session);
      return session.account;
    });
  }

  public async register(input: RegisterInput): Promise<Account> {
    return this.credentials.runExclusive(async () => {
      const session = await this.publicJson<AuthResult>("/auth/register", {
        body: JSON.stringify(input),
        headers: {"Content-Type": "application/json"},
        method: "POST",
      });
      assertAuthResult(session);
      await this.adoptSession(session);
      return session.account;
    });
  }

  public async getMe(): Promise<Account> {
    const value = await this.authorizedJson<Account>("/me");
    assertAccount(value);
    return value;
  }

  public async listServers(): Promise<Server[]> {
    const servers: Server[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;

    do {
      const query: string = cursor
        ? `?cursor=${encodeURIComponent(cursor)}`
        : "";
      const page: unknown = await this.authorizedJson<unknown>(
        `/servers${query}`,
      );
      if (!isRecord(page) || !Array.isArray(page.items)) {
        throw protocolError("Server 列表响应结构不合法");
      }
      for (const item of page.items) {
        if (!isServer(item)) {
          throw protocolError("Server 列表包含非法资源");
        }
        if (!ids.has(item.id)) {
          ids.add(item.id);
          servers.push(item);
        }
      }
      if (servers.length > 10_000) {
        throw protocolError("Server 列表超过客户端安全上限");
      }

      const next: unknown = page.nextCursor;
      if (next !== null && next !== undefined && typeof next !== "string") {
        throw protocolError("Server cursor 类型不合法");
      }
      cursor = typeof next === "string" && next.length > 0 ? next : null;
      if (cursor) {
        if (cursors.has(cursor)) {
          throw protocolError("Server cursor 出现循环");
        }
        cursors.add(cursor);
      }
    } while (cursor);

    return servers;
  }

  public async createServer(
    input: CreateServerInput,
    idempotencyKey: string,
  ): Promise<CreateServerResult> {
    const value = await this.authorizedJson<unknown>("/servers", {
      body: JSON.stringify(input),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    });
    if (isServer(value)) {
      return {kind: "ready", resource: value};
    }
    if (isAcceptedResource(value)) {
      return {accepted: value, kind: "accepted"};
    }
    throw protocolError("Server 创建响应结构不合法");
  }

  public async updateServer(
    serverId: string,
    input: UpdateServerInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Server> {
    assertRevision(revision, "Server");
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}`,
      {
        body: JSON.stringify(input),
        headers: {
          ...mutationHeaders(idempotencyKey),
          "X-Resource-Revision": String(revision),
        },
        method: "PATCH",
      },
    );
    if (!isServer(value)) {
      throw protocolError("Server 更新响应结构不合法");
    }
    return value;
  }

  public async listChannels(serverId: string): Promise<Channel[]> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/channels`,
    );
    if (!Array.isArray(value) || !value.every(isChannel)) {
      throw protocolError("Channel 列表响应结构不合法");
    }
    return value;
  }

  public async createChannel(
    serverId: string,
    input: CreateChannelInput,
    idempotencyKey: string,
  ): Promise<AcceptedResource> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/channels`,
      {
        body: JSON.stringify(input),
        headers: mutationHeaders(idempotencyKey),
        method: "POST",
      },
    );
    if (!isAcceptedResource(value)) {
      throw protocolError("Channel 创建响应结构不合法");
    }
    return value;
  }

  public async updateChannel(
    serverId: string,
    channelId: string,
    input: UpdateChannelInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Channel> {
    assertRevision(revision, "Channel");
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(
        channelId,
      )}`,
      {
        body: JSON.stringify(input),
        headers: {
          ...mutationHeaders(idempotencyKey),
          "X-Resource-Revision": String(revision),
        },
        method: "PATCH",
      },
    );
    if (!isChannel(value)) {
      throw protocolError("Channel 更新响应结构不合法");
    }
    return value;
  }

  public async listDirectConversations(
    serverId: string,
  ): Promise<DirectConversationResource[]> {
    const conversations: DirectConversationResource[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    const path = `/servers/${encodeURIComponent(serverId)}/direct-conversations`;
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page = await this.authorizedJson<unknown>(`${path}${query}`);
      if (!isRecord(page) || !Array.isArray(page.items) ||
          !page.items.every(isDirectConversationResource)) {
        throw protocolError("Server 内私信列表响应结构不合法");
      }
      for (const item of page.items) {
        if (!ids.has(item.id)) {
          ids.add(item.id);
          conversations.push(item);
        }
      }
      if (conversations.length > 10_000) {
        throw protocolError("Server 内私信列表超过客户端安全上限");
      }
      cursor = pageCursor(page, "Server 内私信");
      if (cursor) {
        if (cursors.has(cursor)) {
          throw protocolError("Server 内私信 cursor 出现循环");
        }
        cursors.add(cursor);
      }
    } while (cursor);
    return conversations;
  }

  public async createDirectConversation(
    serverId: string,
    peerMemberId: string,
    idempotencyKey: string,
  ): Promise<CreateDirectConversationResult> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/direct-conversations`,
      {
        body: JSON.stringify({peerMemberId} satisfies CreateDirectConversationInput),
        headers: mutationHeaders(idempotencyKey),
        method: "POST",
      },
    );
    if (isDirectConversationResource(value)) {
      return {kind: "ready", resource: value};
    }
    if (isAcceptedResource(value)) {
      return {accepted: value, kind: "accepted"};
    }
    throw protocolError("Server 内私信创建响应结构不合法");
  }

  public async getDirectConversation(
    serverId: string,
    directConversationId: string,
  ): Promise<DirectConversationResource> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/direct-conversations/${encodeURIComponent(directConversationId)}`,
    );
    if (!isDirectConversationResource(value)) {
      throw protocolError("Server 内私信详情响应结构不合法");
    }
    return value;
  }

  public async retryDirectConversation(
    serverId: string,
    directConversationId: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/direct-conversations/${encodeURIComponent(directConversationId)}/retry`,
      {headers: mutationHeaders(idempotencyKey), method: "POST"},
    );
    if (!isAcceptedResource(value)) {
      throw protocolError("Server 内私信恢复响应结构不合法");
    }
    return value;
  }

  public async ensureThread(
    serverId: string,
    channelId: string,
    input: EnsureThreadInput,
    idempotencyKey: string,
  ): Promise<MessageThread> {
    const value = await this.authorizedJson<unknown>(
      threadCollectionPath(serverId, channelId),
      {
        body: JSON.stringify(input),
        headers: mutationHeaders(idempotencyKey),
        method: "POST",
      },
    );
    if (!isMessageThread(value)) {
      throw protocolError("Thread 响应结构不合法");
    }
    return value;
  }

  public async registerThreadReply(
    serverId: string,
    channelId: string,
    threadId: string,
    input: RegisterThreadReplyInput,
    idempotencyKey: string,
  ): Promise<ThreadReplyReference> {
    const value = await this.authorizedJson<unknown>(
      `${threadPath(serverId, channelId, threadId)}/replies`,
      {
        body: JSON.stringify(input),
        headers: mutationHeaders(idempotencyKey),
        method: "POST",
      },
    );
    if (!isThreadReplyReference(value)) {
      throw protocolError("Thread reply 引用响应结构不合法");
    }
    return value;
  }

  public async listThreadReplies(
    serverId: string,
    channelId: string,
    threadId: string,
    cursor?: string,
  ): Promise<ThreadReplyReferencePage> {
    const query = cursor
      ? `?cursor=${encodeURIComponent(cursor)}`
      : "";
    const value = await this.authorizedJson<unknown>(
      `${threadPath(serverId, channelId, threadId)}/replies${query}`,
    );
    if (!isThreadReplyReferencePage(value)) {
      throw protocolError("Thread reply 列表响应结构不合法");
    }
    return {
      items: value.items,
      ...(typeof value.nextCursor === "string" &&
      value.nextCursor.length > 0
        ? {nextCursor: value.nextCursor}
        : {}),
    };
  }

  public async markThreadRead(
    serverId: string,
    channelId: string,
    threadId: string,
    lastReadRefId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.authorizedVoid(
      `${threadPath(serverId, channelId, threadId)}/read`,
      {
        body: JSON.stringify({lastReadRefId}),
        headers: mutationHeaders(idempotencyKey),
        method: "PUT",
      },
    );
  }

  public async listMembers(serverId: string): Promise<Member[]> {
    const members: Member[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    const path = `/servers/${encodeURIComponent(serverId)}/members`;
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page = await this.authorizedJson<unknown>(`${path}${query}`);
      if (!isRecord(page) || !Array.isArray(page.items) ||
          !page.items.every(isMember)) {
        throw protocolError("Server Member 列表响应结构不合法");
      }
      for (const item of page.items) {
        if (!ids.has(item.id)) {
          ids.add(item.id);
          members.push(item);
        }
      }
      if (members.length > 10_000) {
        throw protocolError("Server Member 列表超过客户端安全上限");
      }
      cursor = pageCursor(page, "Server Member");
      if (cursor) {
        if (cursors.has(cursor)) {
          throw protocolError("Server Member cursor 出现循环");
        }
        cursors.add(cursor);
      }
    } while (cursor);
    return members;
  }

  public async listInvites(serverId: string): Promise<Invite[]> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/invites`,
    );
    if (!Array.isArray(value) || !value.every(isInvite)) {
      throw protocolError("邀请列表响应结构不合法");
    }
    return value;
  }

  public async updateMember(
    serverId: string,
    memberId: string,
    input: UpdateMemberInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Member> {
    assertRevision(revision, "Member");
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(
        memberId,
      )}`,
      {
        body: JSON.stringify(input),
        headers: {
          ...mutationHeaders(idempotencyKey),
          "X-Resource-Revision": String(revision),
        },
        method: "PATCH",
      },
    );
    if (!isMember(value)) {
      throw protocolError("Member 更新响应结构不合法");
    }
    return value;
  }

  public async removeMember(
    serverId: string,
    memberId: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(
        memberId,
      )}`,
      {
        headers: mutationHeaders(idempotencyKey),
        method: "DELETE",
      },
    );
    if (!isAcceptedResource(value)) {
      throw protocolError("Member 移除响应结构不合法");
    }
    return value;
  }

  public async createInvite(
    serverId: string,
    input: CreateInviteInput,
  ): Promise<InviteSecret> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/invites`,
      {
        body: JSON.stringify(input),
        headers: {"Content-Type": "application/json"},
        method: "POST",
      },
    );
    if (!isInviteSecret(value)) {
      throw protocolError("邀请创建响应结构不合法");
    }
    return value;
  }

  public async revokeInvite(
    serverId: string,
    inviteId: string,
  ): Promise<void> {
    await this.authorizedVoid(
      `/servers/${encodeURIComponent(serverId)}/invites/${encodeURIComponent(
        inviteId,
      )}`,
      {method: "DELETE"},
    );
  }

  public async acceptInvite(
    token: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource> {
    const value = await this.authorizedJson<unknown>("/invites/accept", {
      body: JSON.stringify({token}),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    });
    if (!isAcceptedResource(value)) {
      throw protocolError("邀请接受响应结构不合法");
    }
    return value;
  }

  public async acceptJoinLink(
    token: string,
    idempotencyKey: string,
  ): Promise<JoinResult> {
    const value = await this.authorizedJson<unknown>("/join-links/accept", {
      body: JSON.stringify({token}),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    });
    if (!isJoinResult(value)) {
      throw protocolError("加入链接响应结构不合法");
    }
    return value;
  }

  public async getServer(serverId: string): Promise<Server> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}`,
    );
    if (!isServer(value)) {
      throw protocolError("Server 响应结构不合法");
    }
    return value;
  }

  public async resolveServerSlug(slug: string): Promise<Server> {
    const value = await this.authorizedJson<unknown>(
      `/server-slugs/${encodeURIComponent(slug)}`,
    );
    if (!isServer(value)) {
      throw protocolError("Server slug 响应结构不合法");
    }
    return value;
  }

  public async listAgents(serverId: string): Promise<Agent[]> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/agents-v2`,
    );
    if (!Array.isArray(value) || !value.every(isAgent)) {
      throw protocolError("Agent 列表响应结构不合法");
    }
    return value;
  }

  public async createAgent(
    serverId: string,
    input: CreateAgentInput,
    idempotencyKey: string,
  ): Promise<AcceptedResource> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/agents-v2`,
      {
        body: JSON.stringify(input),
        headers: mutationHeaders(idempotencyKey),
        method: "POST",
      },
    );
    if (!isAcceptedResource(value)) {
      throw protocolError("Agent 创建响应结构不合法");
    }
    return value;
  }

  public async updateAgent(
    serverId: string,
    agentId: string,
    input: UpdateAgentInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Agent> {
    assertRevision(revision, "Agent");
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/agents-v2/${encodeURIComponent(
        agentId,
      )}`,
      {
        body: JSON.stringify(input),
        headers: {
          ...mutationHeaders(idempotencyKey),
          "X-Resource-Revision": String(revision),
        },
        method: "PATCH",
      },
    );
    if (!isAgent(value)) {
      throw protocolError("Agent 更新响应结构不合法");
    }
    return value;
  }

  public async getAgentProfileCapabilities(
    serverId: string,
    agentId: string,
  ): Promise<AgentProfileCapabilities> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(
        agentId,
      )}/profile-capabilities`,
    );
    if (!isAgentProfileCapabilities(value)) {
      throw protocolError("Agent Profile 能力响应结构不合法");
    }
    return value;
  }

  public async refreshAgentProfileCapabilities(
    serverId: string,
    agentId: string,
    idempotencyKey: string,
  ): Promise<Operation> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(
        agentId,
      )}/profile-capabilities/refresh`,
      {
        headers: mutationHeaders(idempotencyKey),
        method: "POST",
      },
    );
    if (!isOperation(value)) {
      throw protocolError("Agent Profile 能力刷新响应结构不合法");
    }
    return value;
  }

  public async agentAction(
    serverId: string,
    agentId: string,
    action: "deploy" | "restart" | "start" | "stop",
    idempotencyKey: string,
  ): Promise<Operation> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(
        agentId,
      )}/${action}`,
      {headers: mutationHeaders(idempotencyKey), method: "POST"},
    );
    if (!isOperation(value)) {
      throw protocolError("Agent 操作响应结构不合法");
    }
    return value;
  }

  public async rotateAgentRuntimeCredential(
    serverId: string,
    agentId: string,
    idempotencyKey: string,
  ): Promise<Operation> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(
        agentId,
      )}/credentials/rotate`,
      {headers: mutationHeaders(idempotencyKey), method: "POST"},
    );
    if (!isOperation(value)) {
      throw protocolError("Agent 运行凭证轮换响应结构不合法");
    }
    return value;
  }

  public async deleteAgent(
    serverId: string,
    agentId: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/agents-v2/${encodeURIComponent(
        agentId,
      )}`,
      {headers: mutationHeaders(idempotencyKey), method: "DELETE"},
    );
    if (!isAcceptedResource(value)) {
      throw protocolError("Agent 删除响应结构不合法");
    }
    return value;
  }

  public async getOperation(
    serverId: string,
    operationId: string,
  ): Promise<Operation> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/operations/${encodeURIComponent(
        operationId,
      )}`,
    );
    if (!isOperation(value)) {
      throw protocolError("Operation 响应结构不合法");
    }
    return value;
  }

  public async listComputers(serverId: string): Promise<Computer[]> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/computers`,
    );
    if (!Array.isArray(value) || !value.every(isComputer)) {
      throw protocolError("Computer 列表响应结构不合法");
    }
    const capabilities = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/computer-runtime-capabilities`,
    );
    if (!Array.isArray(capabilities) ||
      !capabilities.every(isComputerRuntimeCapability)) {
      throw protocolError("Computer Runtime 能力响应结构不合法");
    }
    const byComputerId = new Map(
      capabilities.map((capability) => [capability.computerId, capability]),
    );
    return value.map((computer) => {
      const capability = byComputerId.get(computer.id);
      return capability
        ? {...computer, assignmentVersion: capability.assignmentVersion}
        : computer;
    });
  }

  public async createComputer(
    serverId: string,
    input: CreateComputerInput,
    idempotencyKey: string,
  ): Promise<Computer> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/computers`,
      {
        body: JSON.stringify(input),
        headers: mutationHeaders(idempotencyKey),
        method: "POST",
      },
    );
    if (!isComputer(value)) {
      throw protocolError("Computer 创建响应结构不合法");
    }
    return value;
  }

  public async removeComputer(
    serverId: string,
    computerId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.authorizedVoid(
      `/servers/${encodeURIComponent(serverId)}/computers/${encodeURIComponent(
        computerId,
      )}`,
      {headers: mutationHeaders(idempotencyKey), method: "DELETE"},
    );
  }

  public async createComputerRegistrationScript(
    serverId: string,
    computerId: string,
    revision: number,
  ): Promise<RegistrationScript> {
	assertRevision(revision, "Computer");
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/computers/${encodeURIComponent(
        computerId,
      )}/setup-commands`,
      {headers: {"X-Resource-Revision": String(revision)}, method: "POST"},
    );
    if (!isRecord(value) || typeof value.command !== "string") {
      throw protocolError("Computer 安装命令响应结构不合法");
    }
    const result = {...value, script: value.command};
    if (!isRegistrationScript(result)) {
      throw protocolError("Computer 安装命令响应结构不合法");
    }
    return result;
  }

  public async createTerminalSession(
    serverId: string,
    computerId: string,
  ): Promise<TerminalSession> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/computers/${encodeURIComponent(
        computerId,
      )}/terminal-sessions`,
      {method: "POST"},
    );
    if (!isTerminalSession(value)) {
      throw protocolError("终端会话响应结构不合法");
    }
    return value;
  }

  public async listChannelMembers(
    serverId: string,
    channelId: string,
  ): Promise<Member[]> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(
        channelId,
      )}/members`,
    );
    if (!Array.isArray(value) || !value.every(isMember)) {
      throw protocolError("Channel Member 列表响应结构不合法");
    }
    return value;
  }

  public async addChannelMember(
    serverId: string,
    channelId: string,
    memberId: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource> {
    return this.changeChannelMember(
      serverId,
      channelId,
      memberId,
      idempotencyKey,
      "PUT",
    );
  }

  public async removeChannelMember(
    serverId: string,
    channelId: string,
    memberId: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource> {
    return this.changeChannelMember(
      serverId,
      channelId,
      memberId,
      idempotencyKey,
      "DELETE",
    );
  }

  public async listTasks(serverId: string): Promise<Task[]> {
    const tasks: Task[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    const path = `/servers/${encodeURIComponent(serverId)}/tasks`;
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page = await this.authorizedJson<unknown>(`${path}${query}`);
      if (!isRecord(page) || !Array.isArray(page.items) ||
          !page.items.every(isTask)) {
        throw protocolError("Task 列表响应结构不合法");
      }
      for (const item of page.items) {
        if (!ids.has(item.id)) {
          ids.add(item.id);
          tasks.push(item);
        }
      }
      if (tasks.length > 10_000) {
        throw protocolError("Task 列表超过客户端安全上限");
      }
      cursor = pageCursor(page, "Task");
      if (cursor) {
        if (cursors.has(cursor)) {
          throw protocolError("Task cursor 出现循环");
        }
        cursors.add(cursor);
      }
    } while (cursor);
    return tasks;
  }

  public async createTask(
    serverId: string,
    input: CreateTaskInput,
    idempotencyKey: string,
  ): Promise<Task> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/tasks`,
      {
        body: JSON.stringify(input),
        headers: mutationHeaders(idempotencyKey),
        method: "POST",
      },
    );
    if (!isTask(value)) {
      throw protocolError("Task 创建响应结构不合法");
    }
    return value;
  }

  public async updateTask(
    serverId: string,
    taskId: string,
    input: UpdateTaskInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Task> {
    assertRevision(revision, "Task");
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/tasks/${encodeURIComponent(
        taskId,
      )}`,
      {
        body: JSON.stringify(input),
        headers: {
          ...mutationHeaders(idempotencyKey),
          "X-Resource-Revision": String(revision),
        },
        method: "PATCH",
      },
    );
    if (!isTask(value)) {
      throw protocolError("Task 更新响应结构不合法");
    }
    return value;
  }

  public async listReminders(serverId: string): Promise<Reminder[]> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/reminders`,
    );
    if (!Array.isArray(value) || !value.every(isReminder)) {
      throw protocolError("Reminder 列表响应结构不合法");
    }
    return value;
  }

  public async createReminder(
    serverId: string,
    input: CreateReminderInput,
    idempotencyKey: string,
  ): Promise<Reminder> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/reminders`,
      {
        body: JSON.stringify(input),
        headers: mutationHeaders(idempotencyKey),
        method: "POST",
      },
    );
    if (!isReminder(value)) {
      throw protocolError("Reminder 创建响应结构不合法");
    }
    return value;
  }

  public async updateReminder(
    serverId: string,
    reminderId: string,
    input: UpdateReminderInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Reminder> {
    assertRevision(revision, "Reminder");
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/reminders/${encodeURIComponent(
        reminderId,
      )}`,
      {
        body: JSON.stringify(input),
        headers: {
          ...mutationHeaders(idempotencyKey),
          "X-Resource-Revision": String(revision),
        },
        method: "PATCH",
      },
    );
    if (!isReminder(value)) {
      throw protocolError("Reminder 更新响应结构不合法");
    }
    return value;
  }

  public async cancelReminder(
    serverId: string,
    reminderId: string,
    revision: number,
    idempotencyKey: string,
  ): Promise<void> {
    assertRevision(revision, "Reminder");
    await this.authorizedVoid(
      `/servers/${encodeURIComponent(serverId)}/reminders/${encodeURIComponent(
        reminderId,
      )}`,
      {
        headers: {
          ...mutationHeaders(idempotencyKey),
          "X-Resource-Revision": String(revision),
        },
        method: "DELETE",
      },
    );
  }

  public async listInbox(serverId: string): Promise<InboxItem[]> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/inbox`,
    );
    if (!Array.isArray(value) || !value.every(isInboxItem)) {
      throw protocolError("Inbox 响应结构不合法");
    }
    return value;
  }

  public async listActivity(serverId: string): Promise<ActivityItem[]> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/activity`,
    );
    if (!Array.isArray(value) || !value.every(isActivityItem)) {
      throw protocolError("Activity 响应结构不合法");
    }
    return value;
  }

  public async createHumanImSession(): Promise<HumanImSession> {
    const value = await this.authorizedJson<unknown>("/me/im/session", {
      method: "POST",
    });
    if (!isHumanImSession(value)) {
      throw protocolError("Human IM Session 响应结构不合法");
    }
    return value;
  }

  private async changeChannelMember(
    serverId: string,
    channelId: string,
    memberId: string,
    idempotencyKey: string,
    method: "DELETE" | "PUT",
  ): Promise<AcceptedResource> {
    const value = await this.authorizedJson<unknown>(
      `/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(
        channelId,
      )}/members/${encodeURIComponent(memberId)}`,
      {headers: mutationHeaders(idempotencyKey), method},
    );
    if (!isAcceptedResource(value)) {
      throw protocolError("Channel membership 响应结构不合法");
    }
    return value;
  }

  public async logout(): Promise<LogoutResult> {
    return this.credentials.runExclusive(async () => {
      const warnings: LogoutResult["warnings"] = [];
      let remoteRevoked = false;
      try {
        if (
          !this.accessToken &&
          (await this.credentials.loadRefreshToken())
        ) {
          await this.refreshWithinLease();
        }
        if (this.accessToken) {
          const response = await this.fetchResponse("/auth/logout", {
            headers: this.authorizationHeaders(),
            method: "POST",
          });
          if (!response.ok) {
            throw await responseError(response);
          }
          remoteRevoked = true;
        }
      } catch (error) {
        const normalized = normalizeError(error);
        warnings.push({
          code: normalized.code,
          message: normalized.message,
        });
      } finally {
        this.clearAccess();
        await this.credentials.clear();
      }
      return {remoteRevoked, warnings};
    });
  }

  private async authorizedJson<T>(
    path: string,
    init: RequestInit = {},
    allowReplay = true,
  ): Promise<T> {
    await this.ensureAccess();
    const response = await this.fetchResponse(path, {
      ...init,
      headers: {
        ...this.authorizationHeaders(),
        ...headersRecord(init.headers),
      },
    });
    if (response.status === 401 && allowReplay && isReplaySafe(path, init)) {
      await this.refreshAccess();
      return this.authorizedJson<T>(path, init, false);
    }
    if (!response.ok) {
      throw await responseError(response);
    }
    return readJson<T>(response);
  }

  private async publicJson<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await this.fetchResponse(path, init);
    if (!response.ok) {
      throw await responseError(response);
    }
    return readJson<T>(response);
  }

  private async authorizedVoid(
    path: string,
    init: RequestInit,
    allowReplay = true,
  ): Promise<void> {
    await this.ensureAccess();
    const response = await this.fetchResponse(path, {
      ...init,
      headers: {
        ...this.authorizationHeaders(),
        ...headersRecord(init.headers),
      },
    });
    if (response.status === 401 && allowReplay && isReplaySafe(path, init)) {
      await this.refreshAccess();
      return this.authorizedVoid(path, init, false);
    }
    if (!response.ok) {
      throw await responseError(response);
    }
  }

  private async ensureAccess(): Promise<void> {
    if (
      this.accessToken &&
      this.accessExpiresAt - this.now().getTime() > 30_000
    ) {
      return;
    }
    await this.refreshAccess();
  }

  private async refreshAccess(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.credentials
        .runExclusive(async () => this.refreshWithinLease())
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    return this.refreshPromise;
  }

  private async refreshWithinLease(): Promise<void> {
    const refreshToken = await this.credentials.loadRefreshToken();
    if (!refreshToken) {
      this.clearAccess();
      throw new PlatformError("AUTH_REQUIRED", "请先登录");
    }

    const response = await this.fetchResponse("/auth/refresh", {
      body: JSON.stringify({refreshToken}),
      headers: {"Content-Type": "application/json"},
      method: "POST",
    });
    if (!response.ok) {
      const error = await responseError(response);
      if (
        error.code === "AUTH_REQUIRED" ||
        error.code === "AUTH_FORBIDDEN"
      ) {
        this.clearAccess();
        await this.credentials.clear();
      }
      throw error;
    }

    let session: AuthResult;
    try {
      session = await readJson<AuthResult>(response);
      assertAuthResult(session);
    } catch (error) {
      this.clearAccess();
      await this.credentials.clear();
      throw error;
    }
    await this.adoptSession(session);
  }

  private async adoptSession(session: AuthResult): Promise<void> {
    this.accessToken = session.accessToken;
    this.accessExpiresAt = Date.parse(session.expiresAt);
    await this.credentials.saveRefreshToken(session.refreshToken);
  }

  private authorizationHeaders(): Record<string, string> {
    if (!this.accessToken) return {};
    return {Authorization: `Bearer ${this.accessToken}`};
  }

  private clearAccess(): void {
    this.accessToken = null;
    this.accessExpiresAt = 0;
  }

  private async fetchResponse(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await this.fetcher(`${this.baseUrl}${path}`, init);
    } catch (error) {
      throw new PlatformError("NETWORK", "无法连接平台服务", {
        details: {
          cause: error instanceof Error ? error.name : "unknown",
        },
      });
    }
  }
}

function assertAuthResult(value: unknown): asserts value is AuthResult {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !isAccount(value.account)
  ) {
    throw protocolError("认证响应结构不合法");
  }
}

function assertAccount(value: unknown): asserts value is Account {
  if (!isAccount(value)) {
    throw protocolError("Account 响应结构不合法");
  }
}

function isAccount(value: unknown): value is Account {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.email === "string" &&
    typeof value.displayName === "string" &&
    typeof value.imState === "string" &&
    typeof value.revision === "number"
  );
}

function isServer(value: unknown): value is Server {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.slug === "string" &&
    typeof value.name === "string" &&
    typeof value.ownerMemberId === "string" &&
    typeof value.imState === "string" &&
    typeof value.revision === "number"
  );
}

function isChannel(value: unknown): value is Channel {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
		typeof value.name === "string" &&
		typeof value.visibility === "string" &&
		typeof value.joined === "boolean" &&
    typeof value.imState === "string" &&
    typeof value.revision === "number"
  );
}

function isDirectConversationResource(
  value: unknown,
): value is DirectConversationResource {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    typeof value.imGroupId === "string" &&
    value.imGroupId.length > 0 &&
    typeof value.status === "string" &&
    typeof value.imState === "string" &&
    typeof value.revision === "number" &&
    isMember(value.memberA) &&
    isMember(value.memberB) &&
    value.memberA.id !== value.memberB.id
  );
}

function isAgent(value: unknown): value is Agent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    typeof value.displayName === "string" &&
    typeof value.handle === "string" &&
    typeof value.imUserId === "string" &&
    typeof value.imState === "string" &&
    typeof value.observedState === "string"
  );
}

function isComputerRuntimeCapability(
  value: unknown,
): value is ComputerRuntimeCapability {
  return isRecord(value) &&
    typeof value.computerId === "string" &&
    typeof value.assignmentVersion === "number" &&
    value.assignmentVersion >= 1;
}

function isAgentProfileCapabilities(
  value: unknown,
): value is AgentProfileCapabilities {
  return isRecord(value) &&
    typeof value.agentId === "string" &&
    ["absent", "current", "stale"].includes(String(value.snapshotState)) &&
    Array.isArray(value.staleReasons) &&
    (value.observedAt === null || typeof value.observedAt === "string") &&
    (value.subject === null || isRecord(value.subject)) &&
    (value.source === null || isRecord(value.source)) &&
    (value.models === null || isRecord(value.models)) &&
    (value.skills === null || isRecord(value.skills)) &&
    (value.refreshOperation === null || isOperation(value.refreshOperation));
}

function isComputer(value: unknown): value is Computer {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    typeof value.name === "string" &&
    typeof value.osType === "string" &&
    typeof value.lifecycleState === "string" &&
    typeof value.connectionState === "string" &&
    typeof value.revision === "number"
  );
}

function isRegistrationScript(
  value: unknown,
): value is RegistrationScript {
  return (
    isRecord(value) &&
    typeof value.computerId === "string" &&
    typeof value.script === "string" &&
    value.script.length > 0 &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    typeof value.revision === "number"
  );
}

function isTerminalSession(value: unknown): value is TerminalSession {
  if (
    !isRecord(value) ||
    value.protocol !== "tencent-tat-pty-v1" ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    typeof value.webSocketUrl !== "string" ||
    !value.webSocketUrl.startsWith("wss://") ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !isRecord(value.authentication) ||
    typeof value.authentication.uin !== "string" ||
    value.authentication.uin.length === 0 ||
    !Number.isSafeInteger(value.authentication.appId) ||
    (value.authentication.appId as number) < 1 ||
    typeof value.authentication.instanceId !== "string" ||
    value.authentication.instanceId.length === 0 ||
    !isRecord(value.terminal)
  ) {
    return false;
  }
  const {cols, maxIdleSeconds, rows} = value.terminal;
  return (
    Number.isSafeInteger(cols) &&
    (cols as number) >= 1 &&
    (cols as number) <= 1000 &&
    Number.isSafeInteger(rows) &&
    (rows as number) >= 1 &&
    (rows as number) <= 1000 &&
    Number.isSafeInteger(maxIdleSeconds) &&
    (maxIdleSeconds as number) >= 1 &&
    (maxIdleSeconds as number) <= 86_400
  );
}

function isMember(value: unknown): value is Member {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    typeof value.kind === "string" &&
    typeof value.role === "string" &&
    typeof value.displayName === "string" &&
    typeof value.handle === "string" &&
    typeof value.status === "string" &&
    typeof value.imState === "string" &&
    typeof value.revision === "number"
  );
}

function isInvite(value: unknown): value is Invite {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    typeof value.role === "string" &&
    typeof value.maxUses === "number" &&
    typeof value.usedCount === "number" &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    typeof value.revision === "number"
  );
}

function isInviteSecret(value: unknown): value is InviteSecret {
  return (
    isRecord(value) &&
    isInvite(value.invite) &&
    typeof value.token === "string" &&
    value.token.length > 0
  );
}

function isJoinResult(value: unknown): value is JoinResult {
  return (
    isRecord(value) &&
    typeof value.serverId === "string" &&
    typeof value.serverSlug === "string" &&
    typeof value.memberId === "string" &&
    typeof value.landingChannelId === "string" &&
    Array.isArray(value.operations) &&
    value.operations.every(isOperation)
  );
}

function isHumanImSession(value: unknown): value is HumanImSession {
  return (
    isRecord(value) &&
    typeof value.sdkAppId === "number" &&
    typeof value.userId === "string" &&
    typeof value.userSig === "string" &&
    typeof value.expiresAt === "string"
  );
}

function isAcceptedResource(value: unknown): value is AcceptedResource {
  return (
    isRecord(value) &&
    typeof value.resourceId === "string" &&
    Array.isArray(value.operations) &&
    value.operations.length > 0 &&
    value.operations.every(isOperation)
  );
}

function isOperation(value: unknown): value is Operation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.service === "string" &&
    typeof value.kind === "string" &&
    typeof value.state === "string" &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

function isTask(value: unknown): value is Task {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    typeof value.number === "number" &&
    Number.isSafeInteger(value.number) &&
    value.number >= 1 &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    typeof value.assignmentRevision === "number" &&
    typeof value.createdByMemberId === "string" &&
    typeof value.updatedByMemberId === "string" &&
    typeof value.revision === "number"
  );
}

function isReminder(value: unknown): value is Reminder {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    typeof value.agentId === "string" &&
    typeof value.createdByMemberId === "string" &&
    typeof value.scheduleKind === "string" &&
    typeof value.schedule === "string" &&
    typeof value.timezone === "string" &&
    typeof value.text === "string" &&
    typeof value.status === "string" &&
    typeof value.revision === "number"
  );
}

function isInboxItem(value: unknown): value is InboxItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    value.kind === "task" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    typeof value.resourceId === "string" &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

function isActivityItem(value: unknown): value is ActivityItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    typeof value.kind === "string" &&
    typeof value.resourceType === "string" &&
    typeof value.resourceId === "string" &&
    typeof value.summary === "string" &&
    typeof value.occurredAt === "string" &&
    Number.isFinite(Date.parse(value.occurredAt))
  );
}

function isMessageThread(value: unknown): value is MessageThread {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    typeof value.channelId === "string" &&
    isMessageReference(value.rootMessageRef) &&
    Number.isSafeInteger(value.replyCount) &&
    (value.replyCount as number) >= 0 &&
    Number.isSafeInteger(value.unreadCount) &&
    (value.unreadCount as number) >= 0 &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.lastReplyAt === undefined ||
      value.lastReplyAt === null ||
      (typeof value.lastReplyAt === "string" &&
        Number.isFinite(Date.parse(value.lastReplyAt))))
  );
}

function isThreadReplyReference(
  value: unknown,
): value is ThreadReplyReference {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.threadId === "string" &&
    isMessageReference(value.messageRef) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

function isThreadReplyReferencePage(
  value: unknown,
): value is ThreadReplyReferencePage {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isThreadReplyReference) &&
    (value.nextCursor === undefined ||
      value.nextCursor === null ||
      typeof value.nextCursor === "string")
  );
}

function isMessageReference(value: unknown): value is MessageReference {
  if (
    !isRecord(value) ||
    (value.kind !== "c2c" && value.kind !== "group") ||
    typeof value.messageId !== "string" ||
    value.messageId.length === 0
  ) {
    return false;
  }
  return (
    (value.sequence === undefined ||
      (Number.isSafeInteger(value.sequence) &&
        (value.sequence as number) > 0)) &&
    (value.timestamp === undefined ||
      (Number.isSafeInteger(value.timestamp) &&
        (value.timestamp as number) > 0))
  );
}

function isReplaySafe(path: string, init: RequestInit): boolean {
  const method = (init.method ?? "GET").toUpperCase();
  const idempotencyKey = new Headers(init.headers).get("Idempotency-Key");
  return (
    method === "GET" ||
    method === "HEAD" ||
    method === "OPTIONS" ||
    (method === "POST" && path === "/me/im/session") ||
    (
      ["POST", "PATCH", "PUT", "DELETE"].includes(method) &&
      Boolean(idempotencyKey)
    )
  );
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw protocolError("平台返回了无法解析的 JSON");
  }
}

function pageCursor(
  page: Record<string, unknown>,
  resourceLabel: string,
): string | null {
  const value = page.nextCursor;
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw protocolError(`${resourceLabel} cursor 类型不合法`);
  }
  return typeof value === "string" && value.length > 0 ? value : null;
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function mutationHeaders(idempotencyKey: string): Record<string, string> {
  const normalized = idempotencyKey.trim();
  if (!normalized) {
    throw new PlatformError("USAGE", "Idempotency-Key 不能为空");
  }
  return {
    "Content-Type": "application/json",
    "Idempotency-Key": normalized,
  };
}

function threadCollectionPath(
  serverId: string,
  channelId: string,
): string {
  return `/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(
    channelId,
  )}/threads`;
}

function threadPath(
  serverId: string,
  channelId: string,
  threadId: string,
): string {
  return `${threadCollectionPath(serverId, channelId)}/${encodeURIComponent(
    threadId,
  )}`;
}

function assertRevision(revision: number, resource: string): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new PlatformError("USAGE", `${resource} revision 无效`);
  }
}

function normalizeError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  return new PlatformError("NETWORK", "平台请求失败");
}

function protocolError(message: string): PlatformError {
  return new PlatformError("PROTOCOL", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
