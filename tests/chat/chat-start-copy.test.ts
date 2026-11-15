import assert from "node:assert/strict";
import test from "node:test";

import { pendingStartFailureMessage } from "../../apps/workbench-web/src/components/pending-start-failure";
import { onboardingNewThreadSelection } from "../../apps/workbench-web/src/runtime/onboarding-selection";

test("a start failure explains the task without repeating the protocol error", () => {
  assert.equal(pendingStartFailureMessage("ACP cannot preserve the requested permission profile").id, "chat.start.permissionUnsupported");
  assert.equal(pendingStartFailureMessage("socket closed").id, "chat.start.failedDetail");
  assert.doesNotMatch(pendingStartFailureMessage("ACP cannot preserve the requested permission profile").defaultMessage, /ACP|permission profile/u);
});

test("onboarding selection becomes the next new conversation default", () => {
  assert.deepEqual(onboardingNewThreadSelection("codex:luna"), { model: "codex:luna", effort: null, serviceTier: null });
  assert.equal(onboardingNewThreadSelection("  "), null);
  assert.equal(onboardingNewThreadSelection(undefined), null);
});
