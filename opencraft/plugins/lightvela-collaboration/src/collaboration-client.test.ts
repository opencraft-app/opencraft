import assert from "node:assert/strict";
import test from "node:test";

import { CollaborationClient } from "./collaboration-client";

test("Server creation uses the existing authenticated contract and preserves the request key", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new CollaborationClient({
    requestRaw: async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return { resourceId: "server-1", operations: [] } as T;
    },
  });

  const result = await client.createServer("Builders", "builders-a1b2c3d4", "request-1");

  assert.equal(result.kind, "accepted");
  assert.equal(result.kind === "accepted" ? result.accepted.resourceId : null, "server-1");
  assert.equal(calls[0]?.path, "/v1/collaboration/servers");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Idempotency-Key"), "request-1");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    name: "Builders",
    slug: "builders-a1b2c3d4",
  });
});

test("Computer client lists attached resources and only attaches an existing instance", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new CollaborationClient({
    requestRaw: async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      if (init?.method === "POST") {
        return { id: "computer-1", instanceId: "instance-1" } as T;
      }
      return { items: [{ id: "computer-1", instanceId: "instance-1" }], nextCursor: null } as T;
    },
  });

  const listed = await client.listComputersV2("server/one");
  const created = await client.attachComputerV2("server/one", "instance-1", null, "idem-1");

  assert.equal(listed[0]?.id, "computer-1");
  assert.equal(created.instanceId, "instance-1");
  assert.equal(calls[0]?.path, "/v1/collaboration/servers/server%2Fone/computers-v2");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    kind: "lightvela_instance",
    instanceId: "instance-1",
  });
  assert.equal(new Headers(calls[1]?.init?.headers).get("Idempotency-Key"), "idem-1");
});

test("member invitation uses the authenticated create and idempotent accept contracts", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new CollaborationClient({
    requestRaw: async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return path.endsWith("/join-links/accept")
        ? { serverId: "server-1", memberId: "member-1", landingChannelId: "channel-1", operations: [] } as T
        : { invite: { id: "invite-1" }, token: "test-invite-token" } as T;
    },
  });

  const created = await client.createInvite("server/one", "2026-10-05T00:00:00Z");
  const accepted = await client.acceptJoinLink("test-invite-token", "request-1");

  assert.equal(created.token, "test-invite-token");
  assert.equal(accepted.serverId, "server-1");
  assert.equal(calls[0]?.path, "/v1/collaboration/servers/server%2Fone/invites");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    role: "member", maxUses: 1, expiresAt: "2026-10-05T00:00:00Z",
  });
  assert.equal(calls[1]?.path, "/v1/collaboration/join-links/accept");
  assert.equal(new Headers(calls[1]?.init?.headers).get("Idempotency-Key"), "request-1");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { token: "test-invite-token" });
});

test("Collaboration does not treat a 200 error envelope as the current account", async () => {
  const client = new CollaborationClient({
    requestRaw: async <T>(): Promise<T> => ({
      error: { code: "internal_error", message: "服务暂时无法完成请求", requestId: "request-1" },
    }) as T,
  });

  await assert.rejects(client.getMe(), /协作服务返回错误/);
});

test("Collaboration does not pass a 200 error envelope to the IM SDK as a session", async () => {
  const client = new CollaborationClient({
    requestRaw: async <T>(): Promise<T> => ({
      error: { code: "internal_error", message: "服务暂时无法完成请求", requestId: "request-1" },
    }) as T,
  });

  await assert.rejects(client.createHumanImSession(), /协作服务返回错误/);
});

test("member invitation rejects a 200 error envelope without revealing a fake token or Server", async () => {
  const client = new CollaborationClient({
    requestRaw: async <T>(): Promise<T> => ({
      error: { code: "internal_error", message: "服务暂时无法完成请求", requestId: "request-1" },
    }) as T,
  });

  await assert.rejects(client.createInvite("server-1", "2026-10-05T00:00:00Z"), /协作服务返回错误/);
  await assert.rejects(client.acceptJoinLink("test-invite-token", "request-1"), /协作服务返回错误/);
});

test("a 200 error envelope cannot become an accepted Server creation", async () => {
  const client = new CollaborationClient({
    requestRaw: async <T>(): Promise<T> => ({
      error: { code: "internal_error", message: "服务暂时无法完成请求", requestId: "request-1" },
    }) as T,
  });

  await assert.rejects(client.createServer("Builders", "builders", "request-1"), /协作服务返回错误/);
});
