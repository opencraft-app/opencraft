import assert from "node:assert/strict";
import test from "node:test";

import { shouldStartSessionDragPreview } from "../src/session-list/drag-preview";

test("session drag preview starts only after the movement threshold", () => {
  const start = { clientX: 20, clientY: 20, screenX: 220, screenY: 320 };
  assert.equal(
    shouldStartSessionDragPreview(start, { clientX: 25, clientY: 25, screenX: 225, screenY: 325 }),
    false,
  );
  assert.equal(
    shouldStartSessionDragPreview(start, { clientX: 29, clientY: 20, screenX: 229, screenY: 320 }),
    true,
  );
});
