import assert from "node:assert/strict";
import test from "node:test";
import {
  distributionActions,
  nextBuildNumber,
  selectExternalGroup,
  testFlightStatus,
} from "../../scripts/release/testflight-ios.mjs";

const external = { id: "external", attributes: { name: "Beta", isInternalGroup: false } };
const internal = { id: "internal", attributes: { name: "Beta", isInternalGroup: true } };
const other = { id: "other", attributes: { name: "Other", isInternalGroup: false } };

test("allocates above the highest reserved or visible iOS build number", () => {
  assert.equal(nextBuildNumber([]), "1");
  assert.equal(nextBuildNumber(["19", "2", "1", "9"]), "20");
  assert.throws(() => nextBuildNumber(["9999"]), /exhausted/u);
  assert.throws(() => nextBuildNumber(["1.2"]), /format/u);
});

test("selects only an unambiguous external TestFlight group", () => {
  assert.equal(selectExternalGroup([internal, external]), external);
  assert.equal(selectExternalGroup([external, other]), undefined);
  assert.equal(selectExternalGroup([internal, external, other], "Beta"), external);
  assert.equal(selectExternalGroup([internal], "Beta"), undefined);
});

test("reports availability only for a live build in external testing and assigned to the target group", () => {
  const ready = {
    upload: "COMPLETE",
    build: { processingState: "VALID", expired: false },
    externalState: "IN_BETA_TESTING",
    group: external,
    listed: true,
  };
  assert.equal(testFlightStatus(ready), "installable");
  assert.equal(testFlightStatus({ ...ready, build: undefined }), "processing");
  assert.equal(testFlightStatus({ ...ready, build: { ...ready.build, expired: true } }), "expired");
  assert.equal(testFlightStatus({ ...ready, listed: false }), "build_not_in_external_group");
  assert.equal(testFlightStatus({ ...ready, group: undefined }), "external_group_selection_required");
  assert.equal(
    testFlightStatus({ ...ready, externalState: "MISSING_EXPORT_COMPLIANCE" }),
    "export_compliance_required",
  );
  assert.equal(testFlightStatus({ ...ready, externalState: "IN_BETA_REVIEW" }), "beta_review_pending");
  assert.equal(testFlightStatus({ ...ready, externalState: "BETA_APPROVED" }), "testing_not_started");
  assert.equal(testFlightStatus({ upload: "FAILED" }), "processing_failed");
});

test("distribution describes, adds and submits a processed build only as far as it still needs", () => {
  const ready = {
    status: "build_not_in_external_group",
    externalState: "READY_FOR_BETA_SUBMISSION",
    listed: false,
    localized: false,
  };
  assert.deepEqual(distributionActions(ready), ["describe", "add_to_group", "submit_for_review"]);
  assert.deepEqual(distributionActions({ ...ready, localized: true }), ["add_to_group", "submit_for_review"]);
  // Already listed (a rerun after adding): only the submission is left.
  assert.deepEqual(
    distributionActions({ ...ready, status: "beta_review_submission_required", listed: true, localized: true }),
    ["submit_for_review"],
  );
  // Submitted but not yet in the group: add it, never submit twice.
  assert.deepEqual(
    distributionActions({
      status: "beta_review_pending",
      externalState: "WAITING_FOR_BETA_REVIEW",
      listed: false,
      localized: true,
    }),
    ["add_to_group"],
  );
  // Nothing to do, or a human decision is needed first.
  for (const status of [
    "installable",
    "testing_not_started",
    "processing",
    "export_compliance_required",
    "beta_review_rejected",
  ])
    assert.deepEqual(distributionActions({ ...ready, status }), [], status);
  assert.deepEqual(
    distributionActions({ status: "beta_review_pending", externalState: "IN_BETA_REVIEW", listed: true }),
    [],
  );
});
