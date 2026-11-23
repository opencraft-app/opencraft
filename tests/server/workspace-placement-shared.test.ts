import test from "node:test";
import assert from "node:assert/strict";
import { WorkspacePlacementProjection } from "../../apps/headless-server/src/workspaces/placement-projection";

test("projection keeps both shared members across a page boundary", async () => {
  const workspaceId = "ws-" + "1".repeat(32);
  const cursor = workspaceId + "." + Buffer.from("child").toString("hex");
  const projection = new WorkspacePlacementProjection({
    async workspacePlacementPage(after) {
      if (after === undefined)
        return { items: [{ workspaceId, hostId: "local-codex", threadId: "child" }], next: cursor };
      assert.equal(after, cursor);
      return { items: [{ workspaceId, hostId: "local-codex", threadId: "parent" }], next: null };
    },
  });
  await projection.refresh();
  assert.equal(projection.has("child"), true);
  assert.equal(projection.has("parent"), true);
  projection.close();
});

test("projection refuses duplicate or backwards member cursors", async () => {
  const workspaceId = "ws-" + "1".repeat(32),
    cursor = workspaceId + "." + Buffer.from("parent").toString("hex");
  const projection = new WorkspacePlacementProjection({
    async workspacePlacementPage(after) {
      if (after === undefined)
        return { items: [{ workspaceId, hostId: "local-codex", threadId: "parent" }], next: cursor };
      return { items: [{ workspaceId, hostId: "local-codex", threadId: "child" }], next: null };
    },
  });
  await assert.rejects(projection.refresh(), /Invalid workspace placement page/);
  assert.throws(() => projection.has("parent"), /unavailable/);
  projection.close();
});
