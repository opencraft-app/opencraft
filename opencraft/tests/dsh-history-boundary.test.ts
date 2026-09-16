import assert from "node:assert/strict";
import test from "node:test";
import { DshTurnProjection } from "../apps/local-agent-host/src/dsh-turn-projection.js";
test("canonical context boundary remains model-visible but does not manufacture a UI user turn", () => {
  const projection = new DshTurnProjection("child", "turn", "/tmp");
  const result = projection.project({ type: "user/message", seq: 0, time: 1,
    data: { id: "boundary", role: "user", content: [{ type: "text", text: "Side conversation boundary" }], source: { kind: "plugin", plugin: "opencraft:history-boundary" } } });
  assert.equal(result.events.length, 0);
});
