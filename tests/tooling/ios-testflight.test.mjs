import assert from "node:assert/strict";
import test from "node:test";
import { nextBuildNumber, selectExternalGroup, testFlightStatus } from "../../scripts/release/testflight-ios.mjs";

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
