import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionLocationInfo } from "../src/session-location/sessionLocation";

test("session location info exposes the local folder label", () => {
  assert.deepEqual(buildSessionLocationInfo("/Users/skipzhang/velalink"), {
    ariaLabel: "位置：velalink",
    kind: "local_folder",
    label: "velalink",
    path: "/Users/skipzhang/velalink",
  });
});

test("session location info handles Windows paths", () => {
  assert.equal(buildSessionLocationInfo("C:\\Users\\skip\\project")?.label, "project");
});

test("session location info ignores empty paths", () => {
  assert.equal(buildSessionLocationInfo("  "), null);
  assert.equal(buildSessionLocationInfo(null), null);
});
