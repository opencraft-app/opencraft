import assert from "node:assert/strict";
import test from "node:test";
import { projectDisclosureHeight } from "../apps/workbench-web/src/components/use-disclosure-height";

test("animated disclosure samples use the Web scroll pixel grid", () => {
  for (const [input, expected] of [[0, 0], [0.49, 0], [0.51, 1], [201.3, 201], [201.8, 202]]) {
    assert.equal(projectDisclosureHeight(input!), expected);
  }
  assert.equal(projectDisclosureHeight("201.8px"), "202px");
  assert.equal(projectDisclosureHeight("0px"), "0px");
});

test("natural layout and non-height CSS values are not constrained", () => {
  for (const value of ["auto", "", "40%", "calc(100% - 2px)", "var(--height)", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(projectDisclosureHeight(value), value);
  }
});
