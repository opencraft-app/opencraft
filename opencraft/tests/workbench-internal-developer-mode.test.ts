import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceInternalDeveloperModeGesture,
  EMPTY_ESCAPE_SEQUENCE,
  INTERNAL_DEVELOPER_MODE_MAX_GAP_MS,
  isInternalAudienceVisible,
  setInternalDeveloperMode,
  toggleInternalDeveloperMode,
} from "../apps/workbench-web/src/internal-developer-mode.ts";

test("internal contribution audiences are projected only in developer mode", () => {
  assert.equal(isInternalAudienceVisible(undefined, false), true);
  assert.equal(isInternalAudienceVisible("public", false), true);
  assert.equal(isInternalAudienceVisible("internal", false), false);
  assert.equal(isInternalAudienceVisible("internal", true), true);
});

function press(
  state = EMPTY_ESCAPE_SEQUENCE,
  key = "Escape",
  now = 0,
  repeat = false,
) {
  return advanceInternalDeveloperModeGesture(state, { key, now, repeat });
}

test("five consecutive Escape presses unlock internal developer mode", () => {
  let state = EMPTY_ESCAPE_SEQUENCE;
  for (let index = 0; index < 4; index += 1) {
    const result = press(state, "Escape", index * 100);
    assert.equal(result.unlocked, false);
    state = result.state;
  }
  const result = press(state, "Escape", 400);
  assert.equal(result.unlocked, true);
  assert.deepEqual(result.state, EMPTY_ESCAPE_SEQUENCE);
});

test("held keys, interruptions, and stale presses cannot unlock the gesture", () => {
  const first = press(EMPTY_ESCAPE_SEQUENCE, "Escape", 0);
  const held = press(first.state, "Escape", 10, true);
  assert.deepEqual(held.state, first.state);

  const interrupted = press(held.state, "a", 20);
  assert.deepEqual(interrupted.state, EMPTY_ESCAPE_SEQUENCE);

  const restarted = press(interrupted.state, "Escape", 30);
  const stale = press(
    restarted.state,
    "Escape",
    30 + INTERNAL_DEVELOPER_MODE_MAX_GAP_MS + 1,
  );
  assert.equal(stale.unlocked, false);
  assert.equal(stale.state.count, 1);
});

test("the same gesture action toggles internal developer mode off again", () => {
  setInternalDeveloperMode(false);
  assert.equal(toggleInternalDeveloperMode(), "enabled");
  assert.equal(toggleInternalDeveloperMode(), "disabled");
  assert.equal(setInternalDeveloperMode(false), false);
});
