import assert from "node:assert/strict";
import test from "node:test";

import { CollaborationClient } from "./collaboration-client";

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
  assert.equal(calls[0]?.path, "/v1/servers/server%2Fone/computers-v2");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    kind: "lightvela_instance",
    instanceId: "instance-1",
  });
  assert.equal(new Headers(calls[1]?.init?.headers).get("Idempotency-Key"), "idem-1");
});
