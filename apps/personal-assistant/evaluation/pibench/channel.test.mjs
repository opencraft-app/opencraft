import test from "node:test";
import assert from "node:assert/strict";
import { visibleReply, busy } from "./channel.mjs";
test("progress and old messages do not become simulator replies", () => {
  assert.equal(
    visibleReply(
      [
        { seq: 1, role: "assistant", text: "old" },
        { seq: 2, role: "user", text: "user" },
        {
          seq: 3,
          role: "assistant",
          text: "working",
          data: { kind: "acknowledgement" },
        },
        {
          seq: 4,
          role: "assistant",
          text: "question",
          data: { kind: "question" },
        },
        { seq: 5, role: "assistant", text: "done", data: { kind: "result" } },
      ],
      1,
    ),
    "question\n\ndone",
  );
});
test("delegated review and delivery must finish before reply", () => {
  for (const status of [
    "queued",
    "running",
    "awaiting_review",
    "awaiting_delivery",
  ])
    assert.equal(
      busy({ works: [{ status }], active: 0, receptionActive: false }),
      true,
    );
  assert.equal(
    busy({
      works: [{ status: "waiting_input" }],
      active: 0,
      receptionActive: false,
    }),
    false,
  );
  assert.equal(busy({ works: [], active: 0, receptionActive: true }), true);
  assert.equal(busy({ works: [], active: 1, receptionActive: false }), true);
});

test("other conversation work cannot hold this conversation reply open", () => {
  assert.equal(
    busy(
      { active: 1, receptionActive: true, works: [{ status: "running" }] },
      { works: [] },
    ),
    false,
  );
  assert.equal(
    busy({ works: [] }, { works: [{ status: "awaiting_review" }] }),
    true,
  );
});
