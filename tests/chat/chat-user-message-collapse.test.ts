import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveUserMessageCollapseState,
  observeUserMessageNaturalHeight,
  observeUserMessageViewportWidth,
  toggleUserMessageExpandedContentIdentity,
  type UserMessageNaturalMeasurement,
} from "@opencraft/chat-core";

function measurement(
  contentIdentity: string,
  contentHeight: number,
  collapsedHeight = 400,
): UserMessageNaturalMeasurement {
  return { contentIdentity, contentHeight, collapsedHeight };
}

test("user-message collapse policy rejects missing and stale measurements", () => {
  assert.equal(deriveUserMessageCollapseState({
    contentIdentity: "current",
    expandedContentIdentity: null,
    measurement: null,
  }), "uncollapsible");
  assert.equal(deriveUserMessageCollapseState({
    contentIdentity: "current",
    expandedContentIdentity: null,
    measurement: measurement("previous", 800),
  }), "uncollapsible");
});

test("only natural content overflow grants collapse eligibility", () => {
  assert.equal(deriveUserMessageCollapseState({
    contentIdentity: "message",
    expandedContentIdentity: null,
    measurement: measurement("message", 400),
  }), "uncollapsible");
  assert.equal(deriveUserMessageCollapseState({
    contentIdentity: "message",
    expandedContentIdentity: null,
    measurement: measurement("message", 402),
  }), "collapsed");
});

test("expansion is content-owned and does not mutate measurement eligibility", () => {
  const natural = measurement("message", 900);
  const expandedIdentity = toggleUserMessageExpandedContentIdentity("message", null);
  assert.equal(deriveUserMessageCollapseState({
    contentIdentity: "message",
    expandedContentIdentity: expandedIdentity,
    measurement: natural,
  }), "expanded");
  assert.equal(toggleUserMessageExpandedContentIdentity("message", expandedIdentity), null);
  assert.equal(deriveUserMessageCollapseState({
    contentIdentity: "replacement",
    expandedContentIdentity: expandedIdentity,
    measurement: natural,
  }), "uncollapsible");
});

test("a clipped visual height cannot revoke an accepted natural measurement", () => {
  const natural = observeUserMessageNaturalHeight(
    observeUserMessageViewportWidth(null, "message", 400, 320),
    "message",
    400,
    900,
    true,
  );
  const first = deriveUserMessageCollapseState({
    contentIdentity: "message",
    expandedContentIdentity: null,
    measurement: natural,
  });
  const rejectedClippedObservation = observeUserMessageNaturalHeight(
    natural,
    "message",
    400,
    400,
    false,
  );
  const afterVisualClip = deriveUserMessageCollapseState({
    contentIdentity: "message",
    expandedContentIdentity: null,
    measurement: rejectedClippedObservation,
  });
  assert.equal(rejectedClippedObservation.contentHeight, 900);
  assert.equal(first, "collapsed");
  assert.equal(afterVisualClip, "collapsed");
});

test("unclipped async growth updates collapse eligibility without accepting a later clipped height", () => {
  const initial = observeUserMessageNaturalHeight(
    observeUserMessageViewportWidth(null, "message", 400, 320),
    "message",
    400,
    280,
    true,
  );
  assert.equal(deriveUserMessageCollapseState({
    contentIdentity: "message", expandedContentIdentity: null, measurement: initial,
  }), "uncollapsible");
  const grown = observeUserMessageNaturalHeight(initial, "message", 400, 720, true);
  assert.equal(deriveUserMessageCollapseState({
    contentIdentity: "message", expandedContentIdentity: null, measurement: grown,
  }), "collapsed");
  assert.equal(observeUserMessageNaturalHeight(grown, "message", 400, 400, false).contentHeight, 720);
  assert.equal(observeUserMessageNaturalHeight(grown, "message", 400, Number.NaN, true).contentHeight, 720);
});

test("clipped layout accepts only growth beyond the confirmed natural height", () => {
  const natural = observeUserMessageNaturalHeight(
    observeUserMessageViewportWidth(null, "message", 400, 320),
    "message", 400, 900, true,
  );
  assert.equal(observeUserMessageNaturalHeight(natural, "message", 400, 400, false).contentHeight, 900);
  assert.equal(observeUserMessageNaturalHeight(natural, "message", 400, 960, false).contentHeight, 960);
  const widthChanged = observeUserMessageViewportWidth(natural, "message", 400, 260);
  assert.equal(observeUserMessageNaturalHeight(widthChanged, "message", 400, 960, false).contentHeight, null);
});

test("native width invalidation rejects the old clipped callback before accepting a new natural height", () => {
  const initial = observeUserMessageNaturalHeight(
    observeUserMessageViewportWidth(null, "message", 400, 320),
    "message",
    400,
    900,
    true,
  );
  assert.equal(initial.contentHeight, 900);

  const invalidated = observeUserMessageViewportWidth(initial, "message", 400, 640);
  assert.equal(invalidated.contentHeight, null);

  const staleClippedLayout = observeUserMessageNaturalHeight(
    invalidated,
    "message",
    400,
    400,
    false,
  );
  assert.equal(staleClippedLayout.contentHeight, null);

  const remeasured = observeUserMessageNaturalHeight(
    staleClippedLayout,
    "message",
    400,
    460,
    true,
  );
  assert.equal(remeasured.contentHeight, 460);
});
