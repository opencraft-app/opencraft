import assert from "node:assert/strict";
import test from "node:test";

import type { Account } from "@lightvela/vela-chat-client-core";
import type { CollaborationComputer } from "./collaboration-client";
import { CollaborationWorkspaceService } from "./collaboration-workspace-service";

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
