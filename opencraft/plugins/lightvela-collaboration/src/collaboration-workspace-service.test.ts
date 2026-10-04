import assert from "node:assert/strict";
import test from "node:test";

import type { Account } from "@lightvela/vela-chat-client-core";
import type { CollaborationComputer } from "./collaboration-client";
import { CollaborationWorkspaceService } from "./collaboration-workspace-service";

test("Workspace retries uncertain Server creation with one idempotency key and opens the listed Server", async () => {
  const server = {
    id: "server-1", slug: "builders-a1b2c3d4", name: "Builders",
    ownerMemberId: "member-1", imState: "provisioning" as const, revision: 1,
  };
  const attempts: Array<{ name: string; slug: string; key: string }> = [];
  let created = false;
  const service = new CollaborationWorkspaceService(
    {
      getMe: async () => ({ id: "account-1" }) as Account,
      listServers: async () => ({ items: created ? [server] : [], nextCursor: null }),
      getServer: async () => server,
      createServer: async (name, slug, key) => {
        attempts.push({ name, slug, key });
        if (attempts.length === 1) throw new Error("connection interrupted");
        created = true;
        return { kind: "accepted", accepted: { resourceId: server.id, operations: [] } };
      },
      createInvite: async () => { throw new Error("not used"); },
      acceptJoinLink: async () => { throw new Error("not used"); },
      listComputersV2: async () => [],
      attachComputerV2: async () => { throw new Error("not used"); },
    },
    { connect: async () => {}, dispose: async () => {} },
    { listInstances: async () => [] },
  );

  await service.load();
  await assert.rejects(service.createServer("Builders"), /connection interrupted/);
  assert.equal(await service.createServer("Builders"), server.id);
  assert.deepEqual(attempts, [
    { name: "Builders", slug: attempts[0]!.slug, key: attempts[0]!.key },
    { name: "Builders", slug: attempts[0]!.slug, key: attempts[0]!.key },
  ]);
  assert.match(attempts[0]!.slug, /^[a-z0-9][a-z0-9-]{1,62}$/);
  assert.deepEqual(service.getSnapshot().servers, [server]);
});

test("Workspace starts a fresh Server attempt after a definitive client rejection", async () => {
  const keys: string[] = [];
  const server = {
    id: "server-2", slug: "new-server", name: "New Server",
    ownerMemberId: "member-1", imState: "ready" as const, revision: 1,
  };
  const service = new CollaborationWorkspaceService(
    {
      getMe: async () => ({ id: "account-1" }) as Account,
      listServers: async () => ({ items: keys.length > 1 ? [server] : [], nextCursor: null }),
      getServer: async () => server,
      createServer: async (_name, _slug, key) => {
        keys.push(key);
        if (keys.length === 1) throw Object.assign(new Error("conflict"), { status: 409 });
        return { kind: "ready", resource: server };
      },
      createInvite: async () => { throw new Error("not used"); },
      acceptJoinLink: async () => { throw new Error("not used"); },
      listComputersV2: async () => [],
      attachComputerV2: async () => { throw new Error("not used"); },
    },
    { connect: async () => {}, dispose: async () => {} },
    { listInstances: async () => [] },
  );

  await service.load();
  await assert.rejects(service.createServer("New Server"), /conflict/);
  assert.equal(await service.createServer("New Server"), server.id);
  assert.notEqual(keys[0], keys[1]);
});

test("a failed read after accepted Server creation must not rotate its idempotency key", async () => {
  const keys: string[] = [];
  const server = {
    id: "server-3", slug: "review", name: "Review",
    ownerMemberId: "member-1", imState: "provisioning" as const, revision: 1,
  };
  let listReads = 0;
  const service = new CollaborationWorkspaceService(
    {
      getMe: async () => ({ id: "account-1" }) as Account,
      listServers: async () => {
        listReads += 1;
        if (listReads === 2) throw Object.assign(new Error("expired"), { status: 401 });
        return { items: listReads === 1 ? [] : [server], nextCursor: null };
      },
      getServer: async () => server,
      createServer: async (_name, _slug, key) => {
        keys.push(key);
        return { kind: "accepted", accepted: { resourceId: server.id, operations: [] } };
      },
      createInvite: async () => { throw new Error("not used"); },
      acceptJoinLink: async () => { throw new Error("not used"); },
      listComputersV2: async () => [],
      attachComputerV2: async () => { throw new Error("not used"); },
    },
    { connect: async () => {}, dispose: async () => {} },
    { listInstances: async () => [] },
  );

  await service.load();
  await assert.rejects(service.createServer("Review"), /expired/);
  assert.equal(await service.createServer("Review"), server.id);
  assert.deepEqual(keys, [keys[0], keys[0]]);
});

test("Workspace keeps account instances separate from Server Computers and refreshes after attach", async () => {
  const computer: CollaborationComputer = {
    id: "computer-1", serverId: "server-1", kind: "lightvela_instance",
    instanceId: "instance-1", name: "Build Mac", lifecycleState: "active",
    observedState: "running", revision: 1, createdAt: "2026-09-14T14:00:00Z",
  };
  let attached = false;
  const service = new CollaborationWorkspaceService(
    {
      getMe: async () => ({ id: "account-1" }) as Account,
      listServers: async () => ({ items: [{ id: "server-1", slug: "one", name: "One", ownerMemberId: "member-1", imState: "ready", revision: 1 }], nextCursor: null }),
      getServer: async () => { throw new Error("not used"); },
      createServer: async () => { throw new Error("not used"); },
      createInvite: async () => { throw new Error("not used"); },
      acceptJoinLink: async () => { throw new Error("not used"); },
      listComputersV2: async () => attached ? [computer] : [],
      attachComputerV2: async (_serverId, instanceId) => {
        assert.equal(instanceId, "instance-1");
        attached = true;
        return computer;
      },
    },
    { connect: async () => {}, dispose: async () => {} },
    { listInstances: async () => [{ instanceId: "instance-1", name: "Build Mac", status: "Running", createdAt: "2026-09-14T13:00:00Z" }] },
	true,
  );

  await service.load();
  assert.equal(service.getSnapshot().availableInstances.length, 1);
  assert.equal(service.getSnapshot().computersByServer["server-1"], undefined);
  await service.loadComputers("server-1");
  assert.deepEqual(service.getSnapshot().computersByServer["server-1"], []);
  const created = await service.attachComputer("server-1", "instance-1");
  assert.equal(created.id, "computer-1");
  assert.equal(service.getSnapshot().computersByServer["server-1"]?.[0]?.instanceId, "instance-1");
});

test("Computer capability is disabled by default and does not read the instance directory", async () => {
  let instanceReads = 0;
  let computerReads = 0;
  const service = new CollaborationWorkspaceService(
    {
      getMe: async () => ({ id: "account-1" }) as Account,
      listServers: async () => ({ items: [], nextCursor: null }),
      getServer: async () => { throw new Error("not used"); },
      createServer: async () => { throw new Error("not used"); },
      createInvite: async () => { throw new Error("not used"); },
      acceptJoinLink: async () => { throw new Error("not used"); },
      listComputersV2: async () => { computerReads += 1; return []; },
      attachComputerV2: async () => { throw new Error("must not attach"); },
    },
    { connect: async () => {}, dispose: async () => {} },
    { listInstances: async () => { instanceReads += 1; return []; } },
  );

  await service.load();
  await service.loadComputers("server-1");
  assert.equal(instanceReads, 0);
  assert.equal(computerReads, 0);
  await assert.rejects(service.attachComputer("server-1", "instance-1"), /not enabled/);
});

test("Workspace accepts a join link with one request key and opens the resulting Server", async () => {
  const server = {
    id: "server-join", slug: "joined", name: "Joined",
    ownerMemberId: "member-owner", imState: "ready" as const, revision: 1,
  };
  const keys: string[] = [];
  let joined = false;
  const service = new CollaborationWorkspaceService(
    {
      getMe: async () => ({ id: "account-1" }) as Account,
      listServers: async () => ({ items: joined ? [server] : [], nextCursor: null }),
      getServer: async () => server,
      createServer: async () => { throw new Error("not used"); },
      createInvite: async (_serverId, expiresAt) => {
        assert.ok(Date.parse(expiresAt) > Date.now());
        return { invite: { id: "invite-1" }, token: "test-invite-token" } as never;
      },
      acceptJoinLink: async (_token, key) => {
        keys.push(key);
        if (keys.length === 1) throw new Error("connection interrupted");
        joined = true;
        return { serverId: server.id } as never;
      },
      listComputersV2: async () => [],
      attachComputerV2: async () => { throw new Error("not used"); },
    },
    { connect: async () => {}, dispose: async () => {} },
    { listInstances: async () => [] },
  );

  await service.load();
  assert.equal(await service.createInvite("server-owner"), "test-invite-token");
  await assert.rejects(service.acceptJoinLink("test-invite-token"), /connection interrupted/);
  assert.equal(await service.acceptJoinLink("test-invite-token"), server.id);
  assert.deepEqual(keys, [keys[0], keys[0]]);
  assert.deepEqual(service.getSnapshot().servers, [server]);
});
