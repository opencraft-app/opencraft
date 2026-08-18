import assert from "node:assert/strict";
import test from "node:test";

import {
  PlatformApi,
  type CredentialStore,
} from "./api.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {"Content-Type": "application/json"},
    status,
  });
}

function account() {
  return {
    displayName: "Skip",
    email: "skip@example.test",
    id: "account-1",
    imState: "ready" as const,
    imUserId: "human-1",
    revision: 1,
  };
}

function authResult(accessToken: string, refreshToken: string) {
  return {
    accessToken,
    account: account(),
    expiresAt: "2026-07-30T18:00:00.000Z",
    refreshToken,
  };
}

function member(id: string, kind: "agent" | "human", imUserId: string) {
  return {
    displayName: id,
    handle: id,
    id,
    imState: "ready" as const,
    imUserId,
    kind,
    revision: 1,
    role: "member" as const,
    serverId: "server-1",
    status: "active" as const,
  };
}

function credentialStore(initial: string | null): CredentialStore & {
  cleared: number;
  leases: number;
  saved: string[];
} {
  let token = initial;
  return {
    cleared: 0,
    leases: 0,
    saved: [],
    async clear() {
      this.cleared += 1;
      token = null;
    },
    async loadRefreshToken() {
      return token;
    },
    async runExclusive<T>(operation: () => Promise<T>) {
      this.leases += 1;
      return operation();
    },
    async saveRefreshToken(value: string) {
      this.saved.push(value);
      token = value;
    },
  };
}

test("restore rotates the persisted token before loading /me", async () => {
  const credentials = credentialStore("refresh-old");
  const calls: Array<{init?: RequestInit; url: string}> = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      calls.push({init, url});
      if (url.endsWith("/auth/refresh")) {
        return json(200, authResult("access-new", "refresh-new"));
      }
      return json(200, account());
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });

  const restored = await api.restore();

  assert.equal(restored.id, "account-1");
  assert.deepEqual(credentials.saved, ["refresh-new"]);
  assert.equal(credentials.leases, 1);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.example.test/v1/auth/refresh",
    "https://api.example.test/v1/me",
  ]);
  assert.deepEqual(calls[1]?.init?.headers, {
    Authorization: "Bearer access-new",
  });
});

test("fetch adapters are invoked without binding PlatformApi as their receiver", async () => {
  const credentials = credentialStore(null);
  const fetcher = async function (
    this: unknown,
    input: RequestInfo | URL,
  ): Promise<Response> {
    assert.equal(this, undefined);
    assert.match(String(input), /\/auth\/login$/);
    return json(200, authResult("access-1", "refresh-1"));
  };
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher,
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });

  const loggedIn = await api.login("skip@example.test", "password");

  assert.equal(loggedIn.id, "account-1");
});

test("Server 内私信 API uses DirectConversation resources instead of global C2C", async () => {
  const credentials = credentialStore(null);
  const calls: Array<{body: unknown; headers: Record<string, string>; method: string; url: string}> = [];
  const direct = {
    id: "0198f4c2-7c10-7c91-a6d2-7d76f9188c01",
    imGroupId: "an_dm_direct",
    imState: "ready",
    memberA: member("member-a", "human", "u_A"),
    memberB: member("member-b", "agent", "u_B"),
    revision: 2,
    serverId: "server-1",
    status: "active",
  };
  const accepted = {
    operations: [{
      createdAt: "2026-08-04T18:00:00Z",
      id: "operation-1",
      kind: "im.direct.ensure",
      service: "im",
      state: "pending",
    }],
    resourceId: direct.id,
  };
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      const method = init?.method ?? "GET";
      calls.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        headers: init?.headers as Record<string, string>,
        method,
        url,
      });
      if (url.endsWith("/retry")) {
        return json(202, accepted);
      }
      if (url.endsWith(`/direct-conversations/${direct.id}`)) {
        return json(200, direct);
      }
      if (method === "POST") {
        return json(202, accepted);
      }
      return json(200, {items: [direct], nextCursor: null});
    },
    now: () => new Date("2026-07-30T17:00:00Z"),
  });
  await api.login("skip@example.test", "password");

  assert.deepEqual(await api.listDirectConversations("server-1"), [direct]);
  assert.deepEqual(
    await api.createDirectConversation("server-1", "member-b", "direct-create-1"),
    {accepted, kind: "accepted"},
  );
  assert.deepEqual(await api.getDirectConversation("server-1", direct.id), direct);
  assert.deepEqual(
    await api.retryDirectConversation("server-1", direct.id, "direct-retry-1"),
    accepted,
  );
  assert.deepEqual(calls.map(({method, url}) => [method, new URL(url).pathname]), [
    ["GET", "/v1/servers/server-1/direct-conversations"],
    ["POST", "/v1/servers/server-1/direct-conversations"],
    ["GET", `/v1/servers/server-1/direct-conversations/${direct.id}`],
    ["POST", `/v1/servers/server-1/direct-conversations/${direct.id}/retry`],
  ]);
  assert.deepEqual(calls[1]?.body, {peerMemberId: "member-b"});
  assert.equal(new Headers(calls[1]?.headers).get("Idempotency-Key"), "direct-create-1");
  assert.equal(new Headers(calls[3]?.headers).get("Idempotency-Key"), "direct-retry-1");
});

test("Thread APIs exchange only Tencent message references", async () => {
  const credentials = credentialStore(null);
  const calls: Array<{
    body: unknown;
    method: string;
    url: string;
  }> = [];
  const rootMessageRef = {
    groupId: "community-1",
    kind: "group" as const,
    messageId: "root-message-1",
    sequence: 100,
    timestamp: 1_785_400_000,
    topicId: "topic-1",
  };
  const replyMessageRef = {
    ...rootMessageRef,
    messageId: "reply-message-1",
    sequence: 108,
    timestamp: 1_785_400_108,
  };
  const thread = {
    channelId: "channel-1",
    createdAt: "2026-07-31T10:00:00Z",
    id: "019fb45a-41bf-78d4-a5c0-a97b85046fc2",
    lastReplyAt: "2026-07-31T10:01:00Z",
    replyCount: 1,
    rootMessageRef,
    serverId: "server-1",
    unreadCount: 1,
  };
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      const method = init?.method ?? "GET";
      calls.push({
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : null,
        method,
        url,
      });
      if (url.endsWith("/replies") && method === "GET") {
        return json(200, {
          items: [{
            createdAt: "2026-07-31T10:01:00Z",
            id: "019fb45a-9d53-71ef-b925-d075796b48d5",
            messageRef: replyMessageRef,
            threadId: thread.id,
          }],
          nextCursor: null,
        });
      }
      if (url.endsWith("/replies")) {
        return json(201, {
          createdAt: "2026-07-31T10:01:00Z",
          id: "019fb45a-9d53-71ef-b925-d075796b48d5",
          messageRef: replyMessageRef,
          threadId: thread.id,
        });
      }
      return json(200, thread);
    },
    now: () => new Date("2026-07-30T17:00:00Z"),
  });
  await api.login("skip@example.test", "password");

  const ensured = await api.ensureThread(
    "server-1",
    "channel-1",
    {rootMessageRef},
    "thread-create-1",
  );
  const reply = await api.registerThreadReply(
    "server-1",
    "channel-1",
    thread.id,
    {messageRef: replyMessageRef},
    "thread-reply-1",
  );
  const page = await api.listThreadReplies(
    "server-1",
    "channel-1",
    thread.id,
  );
  await api.markThreadRead(
    "server-1",
    "channel-1",
    thread.id,
    reply.id,
    "thread-read-1",
  );

  assert.equal(ensured.id, thread.id);
  assert.equal(reply.messageRef.messageId, "reply-message-1");
  assert.equal(page.items[0]?.messageRef.sequence, 108);
  assert.deepEqual(calls.map(({method, url}) => [
    method,
    new URL(url).pathname,
  ]), [
    ["POST", "/v1/servers/server-1/channels/channel-1/threads"],
    [
      "POST",
      `/v1/servers/server-1/channels/channel-1/threads/${thread.id}/replies`,
    ],
    [
      "GET",
      `/v1/servers/server-1/channels/channel-1/threads/${thread.id}/replies`,
    ],
    [
      "PUT",
      `/v1/servers/server-1/channels/channel-1/threads/${thread.id}/read`,
    ],
  ]);
});

test("listServers exhausts cursors while Channel and Agent lists stay arrays", async () => {
  const credentials = credentialStore(null);
  const calls: string[] = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test/v1",
    credentials,
    fetcher: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      if (url.endsWith("/servers")) {
        return json(200, {
          items: [
            {
              id: "server-1",
              imState: "ready",
              name: "Atlas",
              ownerMemberId: "member-1",
              revision: 1,
              slug: "atlas",
            },
          ],
          nextCursor: "cursor-2",
        });
      }
      if (url.endsWith("/servers?cursor=cursor-2")) {
        return json(200, {
          items: [
            {
              id: "server-2",
              imState: "ready",
              name: "Mono",
              ownerMemberId: "member-2",
              revision: 1,
              slug: "mono",
            },
          ],
          nextCursor: null,
        });
      }
      if (url.endsWith("/channels")) return json(200, []);
      if (url.endsWith("/agents-v2")) return json(200, []);
      throw new Error(`unexpected request: ${url}`);
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const servers = await api.listServers();
  const channels = await api.listChannels("server-1");
  const agents = await api.listAgents("server-1");

  assert.deepEqual(servers.map((server) => server.id), ["server-1", "server-2"]);
  assert.deepEqual(channels, []);
  assert.deepEqual(agents, []);
});

test("listMembers exhausts the OpenAPI page envelope", async () => {
  const credentials = credentialStore(null);
  const calls: string[] = [];
  const member = (id: string) => ({
    accountId: `account-${id}`,
    displayName: id,
    handle: id,
    id,
    imState: "ready",
    imUserId: `im-${id}`,
    kind: "human",
    revision: 1,
    role: "member",
    serverId: "server-1",
    status: "active",
  });
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      if (url.endsWith("/members")) {
        return json(200, {items: [member("member-1")], nextCursor: "members-2"});
      }
      if (url.endsWith("/members?cursor=members-2")) {
        return json(200, {items: [member("member-2")], nextCursor: null});
      }
      throw new Error(`unexpected request: ${url}`);
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const members = await api.listMembers("server-1");

  assert.deepEqual(members.map((value) => value.id), ["member-1", "member-2"]);
  assert.equal(calls.at(-1)?.endsWith("/members?cursor=members-2"), true);
});

test("listTasks exhausts the OpenAPI page envelope", async () => {
  const credentials = credentialStore(null);
  const task = (id: string, number: number) => ({
    assignmentRevision: 1,
    createdByMemberId: "member-1",
    id,
    number,
    revision: 1,
    serverId: "server-1",
    status: "todo",
    title: id,
    updatedByMemberId: "member-1",
  });
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      if (url.endsWith("/tasks")) {
        return json(200, {items: [task("task-1", 1)], nextCursor: "tasks-2"});
      }
      if (url.endsWith("/tasks?cursor=tasks-2")) {
        return json(200, {items: [task("task-2", 2)], nextCursor: null});
      }
      throw new Error(`unexpected request: ${url}`);
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const tasks = await api.listTasks("server-1");

  assert.deepEqual(tasks.map((value) => value.id), ["task-1", "task-2"]);
});

test("an allowed 401 response refreshes once and replays the IM session request", async () => {
  const credentials = credentialStore(null);
  let sessionAttempts = 0;
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-old", "refresh-old"));
      }
      if (url.endsWith("/me/im/session")) {
        sessionAttempts += 1;
        return sessionAttempts === 1
          ? json(401, {error: {code: "expired", message: "expired", requestId: "r1"}})
          : json(200, {
              expiresAt: "2026-07-30T18:00:00.000Z",
              sdkAppId: 1_600_154_578,
              userId: "human-1",
              userSig: "redacted",
            });
      }
      if (url.endsWith("/auth/refresh")) {
        return json(200, authResult("access-new", "refresh-new"));
      }
      throw new Error(`unexpected request: ${url}`);
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const session = await api.createHumanImSession();

  assert.equal(session.sdkAppId, 1_600_154_578);
  assert.equal(sessionAttempts, 2);
  assert.deepEqual(credentials.saved, ["refresh-old", "refresh-new"]);
});

test("logout always clears local credentials and reports failed remote revocation", async () => {
  const credentials = credentialStore(null);
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      return json(503, {error: {code: "unavailable", message: "维护中", requestId: "r2"}});
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const result = await api.logout();

  assert.equal(result.remoteRevoked, false);
  assert.equal(result.warnings[0]?.code, "REMOTE_UNAVAILABLE");
  assert.equal(credentials.cleared, 1);
});

test("logout restores a persisted session before revoking it remotely", async () => {
  const credentials = credentialStore("refresh-old");
  const calls: Array<{headers: Headers; url: string}> = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      calls.push({headers: new Headers(init?.headers), url});
      if (url.endsWith("/auth/refresh")) {
        return json(200, authResult("access-new", "refresh-new"));
      }
      if (url.endsWith("/auth/logout")) {
        return new Response(null, {status: 204});
      }
      throw new Error(`unexpected request: ${url}`);
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });

  const result = await api.logout();

  assert.equal(result.remoteRevoked, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://api.example.test/v1/auth/refresh",
      "https://api.example.test/v1/auth/logout",
    ],
  );
  assert.equal(calls[1]?.headers.get("Authorization"), "Bearer access-new");
  assert.equal(credentials.cleared, 1);
});

test("registration and resource point lookups follow the OpenAPI routes", async () => {
  const credentials = credentialStore(null);
  const calls: string[] = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/auth/register")) {
        return json(201, authResult("access-register", "refresh-register"));
      }
      if (url.endsWith("/servers/server-1")) {
        return json(200, {
          id: "server-1",
          imState: "ready",
          name: "Atlas",
          ownerMemberId: "member-1",
          revision: 1,
          slug: "atlas",
        });
      }
      if (url.endsWith("/server-slugs/atlas")) {
        return json(200, {
          id: "server-1",
          imState: "ready",
          name: "Atlas",
          ownerMemberId: "member-1",
          revision: 1,
          slug: "atlas",
        });
      }
      if (url.endsWith("/channels/channel-1/members")) {
        return json(200, []);
      }
      throw new Error(`unexpected request: ${url}`);
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });

  await api.register({
    displayName: "Skip",
    email: "skip@example.test",
    password: "password",
  });
  const byId = await api.getServer("server-1");
  const bySlug = await api.resolveServerSlug("atlas");
  const members = await api.listChannelMembers("server-1", "channel-1");

  assert.equal(byId.id, bySlug.id);
  assert.deepEqual(members, []);
  assert.deepEqual(credentials.saved, ["refresh-register"]);
  assert.deepEqual(calls, [
    "https://api.example.test/v1/auth/register",
    "https://api.example.test/v1/servers/server-1",
    "https://api.example.test/v1/server-slugs/atlas",
    "https://api.example.test/v1/servers/server-1/channels/channel-1/members",
  ]);
});

test("concurrent restore calls share one refresh rotation", async () => {
  const credentials = credentialStore("refresh-old");
  let refreshCalls = 0;
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return json(200, authResult("access-new", "refresh-new"));
      }
      return json(200, account());
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });

  await Promise.all([api.restore(), api.restore()]);

  assert.equal(refreshCalls, 1);
  assert.equal(credentials.leases, 1);
});

test("invite and Server member methods follow the management contract", async () => {
  const credentials = credentialStore(null);
  const calls: Array<{
    body: unknown;
    headers: Headers;
    method: string;
    url: string;
  }> = [];
  const invite = {
    expiresAt: "2026-07-31T18:00:00.000Z",
    id: "invite-1",
    maxUses: 3,
    revision: 1,
    role: "member",
    serverId: "server-1",
    usedCount: 0,
  };
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      calls.push({
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : null,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      });
      if (url.endsWith("/invites/accept")) {
        return json(202, {
          operations: [{
            createdAt: "2026-07-30T18:00:00.000Z",
            id: "operation-1",
            kind: "im.membership.ensure",
            service: "im",
            state: "pending",
          }],
          resourceId: "member-1",
        });
      }
      if (url.endsWith("/join-links/accept")) {
        return json(200, {
          landingChannelId: "channel-all",
          memberId: "member-1",
          operations: [],
          serverId: "server-1",
          serverSlug: "atlas",
        });
      }
      if (url.endsWith("/invites/invite-1")) {
        return new Response(null, {status: 204});
      }
      if (url.endsWith("/invites") && init?.method === "POST") {
        return json(201, {invite, token: "rfi_secret"});
      }
      if (url.endsWith("/invites")) return json(200, [invite]);
      if (url.endsWith("/members")) {
        return json(200, {items: [], nextCursor: null});
      }
      throw new Error(`unexpected request: ${url}`);
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const members = await api.listMembers("server-1");
  const created = await api.createInvite("server-1", {
    expiresAt: "2026-07-31T18:00:00.000Z",
    maxUses: 3,
    role: "member",
  });
  const invites = await api.listInvites("server-1");
  await api.revokeInvite("server-1", "invite-1");
  const accepted = await api.acceptInvite(
    "rfi_secret",
    "accept-invite-0001",
  );
  const joined = await api.acceptJoinLink(
    "rfi_secret",
    "accept-join-link-0001",
  );

  assert.deepEqual(members, []);
  assert.equal(created.token, "rfi_secret");
  assert.equal(invites[0]?.id, "invite-1");
  assert.equal(accepted.resourceId, "member-1");
  assert.equal(joined.serverSlug, "atlas");
  assert.equal(joined.landingChannelId, "channel-all");
  assert.deepEqual(
    calls.map((call) => [call.method, call.url]),
    [
      ["GET", "https://api.example.test/v1/servers/server-1/members"],
      ["POST", "https://api.example.test/v1/servers/server-1/invites"],
      ["GET", "https://api.example.test/v1/servers/server-1/invites"],
      ["DELETE", "https://api.example.test/v1/servers/server-1/invites/invite-1"],
      ["POST", "https://api.example.test/v1/invites/accept"],
      ["POST", "https://api.example.test/v1/join-links/accept"],
    ],
  );
  assert.equal(calls[1]?.headers.get("Idempotency-Key"), null);
  assert.equal(
    calls[4]?.headers.get("Idempotency-Key"),
    "accept-invite-0001",
  );
  assert.equal(
    calls[5]?.headers.get("Idempotency-Key"),
    "accept-join-link-0001",
  );
});

test("member update and removal preserve revision and idempotency headers", async () => {
  const credentials = credentialStore(null);
  const calls: Array<{headers: Headers; method: string; url: string}> = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      calls.push({
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      });
      if (init?.method === "PATCH") {
        return json(200, {
          accountId: "account-1",
          displayName: "管理员",
          handle: "member",
          id: "member-1",
          imState: "ready",
          imUserId: "u_MEMBER",
          kind: "human",
          revision: 2,
          role: "admin",
          serverId: "server-1",
          status: "active",
        });
      }
      return json(202, {
        operations: [{
          createdAt: "2026-07-30T18:00:00.000Z",
          id: "operation-remove",
          kind: "im.membership.remove",
          service: "im",
          state: "pending",
        }],
        resourceId: "member-1",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const updated = await api.updateMember(
    "server-1",
    "member-1",
    {displayName: "管理员", role: "admin"},
    1,
    "member-update-0001",
  );
  const removed = await api.removeMember(
    "server-1",
    "member-1",
    "member-remove-0001",
  );

  assert.equal(updated.revision, 2);
  assert.equal(removed.operations[0]?.kind, "im.membership.remove");
  assert.equal(calls[0]?.headers.get("X-Resource-Revision"), "1");
  assert.equal(
    calls[0]?.headers.get("Idempotency-Key"),
    "member-update-0001",
  );
  assert.equal(
    calls[1]?.headers.get("Idempotency-Key"),
    "member-remove-0001",
  );
});

test("ordinary Channel membership mutations use member-scoped routes", async () => {
  const credentials = credentialStore(null);
  const calls: Array<{headers: Headers; method: string; url: string}> = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      calls.push({
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      });
      return json(202, {
        operations: [{
          createdAt: "2026-07-30T18:00:00.000Z",
          id: `operation-${init?.method}`,
          kind: init?.method === "PUT"
            ? "im.membership.ensure"
            : "im.membership.remove",
          service: "im",
          state: "pending",
        }],
        resourceId: "channel-member-1",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  await api.addChannelMember(
    "server-1", "channel-1", "member-1", "channel-add-0001",
  );
  await api.removeChannelMember(
    "server-1", "channel-1", "member-1", "channel-remove-0001",
  );

  assert.deepEqual(
    calls.map((call) => [call.method, call.url]),
    [
      [
        "PUT",
        "https://api.example.test/v1/servers/server-1/channels/channel-1/members/member-1",
      ],
      [
        "DELETE",
        "https://api.example.test/v1/servers/server-1/channels/channel-1/members/member-1",
      ],
    ],
  );
  assert.equal(
    calls[0]?.headers.get("Idempotency-Key"),
    "channel-add-0001",
  );
});

test("Agent and Computer management methods follow platform control routes", async () => {
  const credentials = credentialStore(null);
  const calls: Array<{
    body: unknown;
    headers: Headers;
    method: string;
    url: string;
  }> = [];
  const operation = {
    createdAt: "2026-07-30T18:00:00.000Z",
    id: "operation-1",
		kind: "agent.start",
		service: "platform",
		state: "succeeded",
  };
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      calls.push({
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : null,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      });
      if (url.endsWith("/computer-runtime-capabilities")) {
        return json(200, [{computerId: "computer-1", assignmentVersion: 3}]);
      }
      if (
        url.endsWith("/computers") &&
        (init?.method ?? "GET") === "GET"
      ) {
        return json(200, []);
      }
      if (url.endsWith("/computers")) {
        return json(201, {
          id: "computer-1",
          lifecycleState: "provisioning",
          name: "外部机器",
          osType: "linux",
          revision: 1,
          serverId: "server-1",
		  connectionState: "unknown",
        });
      }
      if (url.endsWith("/setup-commands")) {
        return json(201, {
		  command: "fixture-install-script",
          computerId: "computer-1",
          expiresAt: "2026-07-30T19:00:00.000Z",
		  revision: 2,
        });
      }
      if (url.endsWith("/agents-v2")) {
        return json(202, {
          operations: [operation],
          resourceId: "agent-1",
        });
      }
      if ((init?.method ?? "GET") === "PATCH") {
        return json(200, {
          credentialVersion: 0,
          desiredState: "stopped",
          displayName: "研究助手 2",
          handle: "researcher",
          id: "agent-1",
          imState: "ready",
          imUserId: "a_researcher",
          observedState: "stopped",
          replyPolicy: "dm_only",
          revision: 2,
          runtime: {kind: "claude"},
          serverId: "server-1",
        });
      }
      return json(202, operation);
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  await api.listComputers("server-1");
  const computer = await api.createComputer(
    "server-1",
	{name: "外部机器"},
    "computer-create-0001",
  );
  const script = await api.createComputerRegistrationScript(
	"server-1", computer.id, computer.revision,
  );
  await api.createAgent(
    "server-1",
    {
      computerId: computer.id,
      displayName: "研究助手",
      handle: "researcher",
      replyPolicy: "mention_and_dm",
      runtime: {kind: "codex"},
    },
    "agent-create-0001",
  );
  const updated = await api.updateAgent(
    "server-1",
    "agent-1",
    {
      displayName: "研究助手 2",
      replyPolicy: "dm_only",
      runtime: {kind: "claude"},
    },
    1,
    "agent-update-0001",
  );
  await api.agentAction(
    "server-1", "agent-1", "start", "agent-start-0001",
  );

	assert.equal(script.script, "fixture-install-script");
	assert.equal(calls[3]?.headers.get("X-Resource-Revision"), "1");
	assert.equal(updated.revision, 2);
	assert.equal("tatRegion" in (calls[2]?.body as object), false);
  assert.deepEqual(calls.map((call) => call.method), [
    "GET", "GET", "POST", "POST", "POST", "PATCH", "POST",
  ]);
  assert.equal(calls[5]?.headers.get("X-Resource-Revision"), "1");
  assert.equal(
    calls[5]?.headers.get("Idempotency-Key"),
    "agent-update-0001",
  );
});

test("removeComputer releases only the platform mapping with an idempotent DELETE", async () => {
  const calls: Array<{headers: Headers; method: string; url: string}> = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials: credentialStore(null),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      calls.push({
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      });
      return new Response(null, {status: 204});
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  await api.removeComputer(
    "server/with spaces",
    "computer/with spaces",
    "computer-remove-0001",
  );

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    [
      "DELETE",
      "https://api.example.test/v1/servers/server%2Fwith%20spaces/computers/computer%2Fwith%20spaces",
    ],
  ]);
  assert.equal(
    calls[0]?.headers.get("Idempotency-Key"),
    "computer-remove-0001",
  );
});

test("reads and explicitly refreshes Agent Profile capabilities", async () => {
  const calls: Array<{headers: Headers; method: string; url: string}> = [];
  const operation = {
    createdAt: "2026-08-18T00:00:00.000Z",
    id: "operation-1",
    kind: "agent.profile.capabilities.refresh",
    service: "platform",
    state: "pending",
  };
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials: credentialStore(null),
    fetcher: async (input, init) => {
      if (String(input).endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      calls.push({
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: String(input),
      });
      if ((init?.method ?? "GET") === "POST") return json(202, operation);
      return json(200, {
        agentId: "agent-1",
        models: null,
        observedAt: null,
        refreshOperation: null,
        skills: null,
        snapshotState: "absent",
        source: null,
        staleReasons: [],
        subject: null,
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });

  await api.login("skip@example.test", "password");

  const capabilities = await api.getAgentProfileCapabilities("server-1", "agent-1");
  const refreshed = await api.refreshAgentProfileCapabilities(
    "server-1",
    "agent-1",
    "profile-refresh-0001",
  );

  assert.equal(capabilities.snapshotState, "absent");
  assert.equal(refreshed.kind, "agent.profile.capabilities.refresh");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
  assert.equal(calls[1]?.headers.get("Idempotency-Key"), "profile-refresh-0001");
});

test("createTerminalSession returns complete one-time PTY bootstrap", async () => {
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials: credentialStore(null),
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      assert.equal(
        url,
        "https://api.example.test/v1/servers/server-1/computers/computer-1/terminal-sessions",
      );
      return json(201, {
        authentication: {
          appId: 1_250_000_000,
          instanceId: "rins-test0001",
          uin: "100000000001",
        },
        expiresAt: "2026-07-30T17:05:00.000Z",
        protocol: "tencent-tat-pty-v1",
        sessionId: "session-test",
        terminal: {cols: 120, maxIdleSeconds: 3600, rows: 32},
        webSocketUrl: "wss://terminal.example.test/connect",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const session = await api.createTerminalSession(
    "server-1",
    "computer-1",
  );

  assert.equal(session.protocol, "tencent-tat-pty-v1");
  assert.equal(session.authentication.uin, "100000000001");
  assert.equal(session.authentication.instanceId, "rins-test0001");
  assert.equal(session.terminal.cols, 120);
});

test("getOperation reads one redacted operation from the server scope", async () => {
  const calls: Array<{method: string; url: string}> = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials: credentialStore(null),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      calls.push({method: init?.method ?? "GET", url});
      return json(200, {
        completedAt: null,
        createdAt: "2026-08-01T03:00:00.000Z",
        error: null,
        id: "operation-1",
		kind: "agent.start",
		service: "platform",
		state: "succeeded",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const operation = await api.getOperation("server-1", "operation-1");

	assert.equal(operation.state, "succeeded");
  assert.deepEqual(calls, [{
    method: "GET",
    url: "https://api.example.test/v1/servers/server-1/operations/operation-1",
  }]);
});

test("rotateAgentRuntimeCredential preserves idempotency and returns the completed platform operation", async () => {
  const calls: Array<{headers: Headers; method: string; url: string}> = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials: credentialStore(null),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      calls.push({
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      });
      return json(202, {
        createdAt: "2026-08-01T03:00:00.000Z",
        id: "operation-rotate-1",
		kind: "agent.credential.rotate",
		service: "platform",
		state: "succeeded",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const operation = await api.rotateAgentRuntimeCredential(
    "server-1",
    "agent-1",
    "credential-rotate-1",
  );

	assert.equal(operation.kind, "agent.credential.rotate");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(
    calls[0]?.url,
    "https://api.example.test/v1/servers/server-1/agents/agent-1/credentials/rotate",
  );
  assert.equal(
    calls[0]?.headers.get("Idempotency-Key"),
    "credential-rotate-1",
  );
});

test("deleteAgent preserves idempotency and accepts asynchronous IM identity deletion", async () => {
  const calls: Array<{headers: Headers; method: string; url: string}> = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials: credentialStore(null),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      calls.push({
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      });
      return json(202, {
        operations: [{
          createdAt: "2026-08-04T03:00:00.000Z",
          id: "operation-delete-1",
          kind: "im.identity.delete",
          service: "im",
          state: "pending",
        }],
        resourceId: "agent-1",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const operation = await api.deleteAgent(
    "server-1",
    "agent-1",
    "agent-delete-1",
  );

  assert.equal(operation.operations[0]?.kind, "im.identity.delete");
  assert.equal(calls[0]?.method, "DELETE");
  assert.equal(
    calls[0]?.url,
    "https://api.example.test/v1/servers/server-1/agents-v2/agent-1",
  );
  assert.equal(calls[0]?.headers.get("Idempotency-Key"), "agent-delete-1");
});

test("createServer preserves idempotency and accepts an asynchronous resource", async () => {
  const credentials = credentialStore(null);
  const calls: Array<{body: unknown; headers: Headers; url: string}> = [];
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      calls.push({
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : null,
        headers: new Headers(init?.headers),
        url,
      });
      return json(202, {
        operations: [
          {
            createdAt: "2026-07-30T18:00:00.000Z",
            id: "operation-1",
            kind: "server.create",
            service: "im",
            state: "pending",
          },
        ],
        resourceId: "server-1",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const result = await api.createServer(
    {name: "Atlas", slug: "atlas"},
    "idem-server-1",
  );

  assert.equal(result.kind, "accepted");
  assert.equal(result.accepted.resourceId, "server-1");
  assert.equal(calls[0]?.url, "https://api.example.test/v1/servers");
  assert.equal(calls[0]?.headers.get("Idempotency-Key"), "idem-server-1");
  assert.equal(calls[0]?.headers.get("Content-Type"), "application/json");
  assert.deepEqual(calls[0]?.body, {name: "Atlas", slug: "atlas"});
});

test("createServer accepts an immediately ready Server response", async () => {
  const credentials = credentialStore(null);
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      return json(201, {
        id: "server-1",
        imState: "ready",
        name: "Atlas",
        ownerMemberId: "member-1",
        revision: 1,
        slug: "atlas",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const result = await api.createServer(
    {name: "Atlas", slug: "atlas"},
    "idem-server-1",
  );

  assert.equal(result.kind, "ready");
  assert.equal(result.resource.id, "server-1");
});

test("createChannel sends the Server-scoped mutation and returns its operation", async () => {
  const credentials = credentialStore(null);
  let mutation: {body: unknown; headers: Headers; url: string} | undefined;
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      mutation = {
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : null,
        headers: new Headers(init?.headers),
        url,
      };
      return json(202, {
        operations: [
          {
            createdAt: "2026-07-30T18:00:00.000Z",
            id: "operation-2",
            kind: "channel.create",
            service: "im",
            state: "pending",
          },
        ],
        resourceId: "channel-1",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const result = await api.createChannel(
    "server-1",
    {name: "产品", visibility: "private"},
    "idem-channel-1",
  );

  assert.equal(result.resourceId, "channel-1");
  assert.equal(
    mutation?.url,
    "https://api.example.test/v1/servers/server-1/channels",
  );
  assert.equal(
    mutation?.headers.get("Idempotency-Key"),
    "idem-channel-1",
  );
  assert.deepEqual(mutation?.body, {
    name: "产品",
    visibility: "private",
  });
});

test("updateChannel preserves revision and idempotency on the Channel route", async () => {
  const credentials = credentialStore(null);
  let mutation:
    | {body: unknown; headers: Headers; method: string; url: string}
    | undefined;
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      mutation = {
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : null,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      };
      return json(200, {
        description: "仅讨论交付",
        id: "channel-1",
        imGroupId: "group-1",
        imState: "ready",
        imTopicId: "topic-1",
        joined: true,
        name: "项目交付",
        revision: 2,
        serverId: "server-1",
        visibility: "private",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const result = await api.updateChannel(
    "server-1",
    "channel-1",
    {description: "仅讨论交付", name: "项目交付"},
    1,
    "idem-channel-update-1",
  );

  assert.equal(result.revision, 2);
  assert.deepEqual(mutation?.body, {
    description: "仅讨论交付",
    name: "项目交付",
  });
  assert.equal(mutation?.method, "PATCH");
  assert.equal(
    mutation?.url,
    "https://api.example.test/v1/servers/server-1/channels/channel-1",
  );
  assert.equal(mutation?.headers.get("X-Resource-Revision"), "1");
  assert.equal(
    mutation?.headers.get("Idempotency-Key"),
    "idem-channel-update-1",
  );
});

test("updateServer preserves revision and idempotency on the Server route", async () => {
  const credentials = credentialStore(null);
  let mutation:
    | {body: unknown; headers: Headers; method: string; url: string}
    | undefined;
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      mutation = {
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      };
      return json(200, {
        description: "协作与运行时研究",
        id: "server-1",
        imState: "ready",
        name: "Vela 研究实验室",
        ownerMemberId: "member-1",
        revision: 2,
        slug: "agent-lab",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  const result = await api.updateServer(
    "server-1",
    {description: "协作与运行时研究", name: "Vela 研究实验室"},
    1,
    "idem-server-update-1",
  );

  assert.equal(result.revision, 2);
  assert.deepEqual(mutation?.body, {
    description: "协作与运行时研究",
    name: "Vela 研究实验室",
  });
  assert.equal(mutation?.method, "PATCH");
  assert.equal(
    mutation?.url,
    "https://api.example.test/v1/servers/server-1",
  );
  assert.equal(mutation?.headers.get("X-Resource-Revision"), "1");
  assert.equal(
    mutation?.headers.get("Idempotency-Key"),
    "idem-server-update-1",
  );
});

test("resource revision zero remains valid as declared by OpenAPI", async () => {
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials: credentialStore(null),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      assert.equal(new Headers(init?.headers).get("X-Resource-Revision"), "0");
      if (url.includes("/channels/")) {
        return json(200, {
          id: "channel-1",
          imState: "ready",
          joined: true,
          name: "General",
          revision: 1,
          serverId: "server-1",
          visibility: "private",
        });
      }
      return json(200, {
        accountId: "account-1",
        displayName: "Member",
        handle: "member",
        id: "member-1",
        imState: "ready",
        imUserId: "im-member-1",
        kind: "human",
        revision: 1,
        role: "member",
        serverId: "server-1",
        status: "active",
      });
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  await api.updateChannel(
    "server-1", "channel-1", {name: "General"}, 0, "channel-update-0",
  );
  await api.updateMember(
    "server-1", "member-1", {displayName: "Member"}, 0, "member-update-0",
  );
});

test("Work methods preserve Server routes, revisions and idempotency", async () => {
  const credentials = credentialStore(null);
  const calls: Array<{
    body: unknown;
    headers: Headers;
    method: string;
    url: string;
  }> = [];
  const task = {
    assignmentRevision: 1,
    createdByMemberId: "member-1",
    id: "task-1",
    number: 1,
    revision: 1,
    serverId: "server-1",
    status: "todo",
    title: "完成 TUI",
    updatedByMemberId: "member-1",
  };
  const reminder = {
    agentId: "agent-1",
    createdByMemberId: "member-1",
    id: "reminder-1",
    revision: 1,
    schedule: "2026-07-30T19:00:00Z",
    scheduleKind: "once",
    serverId: "server-1",
    status: "active",
    text: "汇报进度",
    timezone: "Asia/Shanghai",
  };
  const api = new PlatformApi({
    baseUrl: "https://api.example.test",
    credentials,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return json(200, authResult("access-1", "refresh-1"));
      }
      const method = init?.method ?? "GET";
      calls.push({
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : null,
        headers: new Headers(init?.headers),
        method,
        url,
      });
      if (method === "DELETE") return new Response(null, {status: 204});
      if (url.endsWith("/inbox")) {
        return json(200, [{
          id: "task-1",
          kind: "task",
          resourceId: "task-1",
          serverId: "server-1",
          status: "in_progress",
          title: "#1 完成 TUI",
          updatedAt: "2026-07-30T18:00:00Z",
        }]);
      }
      if (url.endsWith("/activity")) {
        return json(200, [{
          id: "task-1",
          kind: "task.changed",
          occurredAt: "2026-07-30T18:00:00Z",
          resourceId: "task-1",
          resourceType: "task",
          serverId: "server-1",
          summary: "Task #1 · 完成 TUI · in_progress",
        }]);
      }
      if (url.includes("/reminders")) {
        return json(method === "POST" ? 201 : 200, url.endsWith("/reminders")
          && method === "GET" ? [reminder] : reminder);
      }
      return json(
        method === "POST" && url.endsWith("/tasks") ? 201 : 200,
        url.endsWith("/tasks") && method === "GET"
          ? {items: [task], nextCursor: null}
          : task,
      );
    },
    now: () => new Date("2026-07-30T17:00:00.000Z"),
  });
  await api.login("skip@example.test", "password");

  await api.listTasks("server-1");
  await api.createTask(
    "server-1", {title: "完成 TUI"}, "task-create-1",
  );
  await api.updateTask(
    "server-1", "task-1", {status: "done"}, 1, "task-update-1",
  );
  await api.listReminders("server-1");
  await api.createReminder(
    "server-1",
    {
      agentId: "agent-1",
      schedule: "2026-07-30T19:00:00Z",
      scheduleKind: "once",
      text: "汇报进度",
      timezone: "Asia/Shanghai",
    },
    "reminder-create-1",
  );
  await api.updateReminder(
    "server-1",
    "reminder-1",
    {status: "paused"},
    1,
    "reminder-update-1",
  );
  await api.cancelReminder(
    "server-1", "reminder-1", 1, "reminder-cancel-1",
  );
  const inbox = await api.listInbox("server-1");
  const activity = await api.listActivity("server-1");

  assert.equal(inbox[0]?.resourceId, "task-1");
  assert.equal(activity[0]?.kind, "task.changed");
  assert.equal(calls[2]?.headers.get("Idempotency-Key"), "task-update-1");
  assert.equal(calls[2]?.headers.get("X-Resource-Revision"), "1");
  assert.equal(calls[5]?.headers.get("X-Resource-Revision"), "1");
  assert.equal(calls[6]?.headers.get("X-Resource-Revision"), "1");
  assert.deepEqual(
    calls.map((call) => [call.method, new URL(call.url).pathname]),
    [
      ["GET", "/v1/servers/server-1/tasks"],
      ["POST", "/v1/servers/server-1/tasks"],
      ["PATCH", "/v1/servers/server-1/tasks/task-1"],
      ["GET", "/v1/servers/server-1/reminders"],
      ["POST", "/v1/servers/server-1/reminders"],
      ["PATCH", "/v1/servers/server-1/reminders/reminder-1"],
      ["DELETE", "/v1/servers/server-1/reminders/reminder-1"],
      ["GET", "/v1/servers/server-1/inbox"],
      ["GET", "/v1/servers/server-1/activity"],
    ],
  );
});
