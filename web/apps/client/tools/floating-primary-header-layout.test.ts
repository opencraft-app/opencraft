import {describe, expect, test} from "bun:test";

import {
  validateFloatingHeaderLayout,
  validateStableLayoutBox,
} from "./floating-primary-header-layout";

describe("floating primary header browser geometry", () => {
  test("accepts an inset wide conversation header above message content", () => {
    expect(validateFloatingHeaderLayout({
      content: {bottom: 860, height: 740, left: 372, right: 1260, top: 120, width: 888},
      header: {bottom: 104, height: 52, left: 388, right: 1244, top: 52, width: 856},
      overlays: [{bottom: 144, height: 32, left: 600, right: 1000, top: 112, width: 400}],
      placement: "inside",
      stage: {bottom: 900, height: 860, left: 372, right: 1260, top: 40, width: 888},
    })).toEqual([]);
  });

  test("accepts a compact primary header immediately before its stage", () => {
    expect(validateFloatingHeaderLayout({
      content: {bottom: 820, height: 670, left: 0, right: 900, top: 150, width: 900},
      header: {bottom: 136, height: 52, left: 10, right: 890, top: 84, width: 880},
      placement: "before",
      stage: {bottom: 820, height: 680, left: 0, right: 900, top: 140, width: 900},
    })).toEqual([]);
  });

  test("rejects edge-attached, wrapped and overlapping headers", () => {
    expect(validateFloatingHeaderLayout({
      content: {bottom: 800, height: 748, left: 0, right: 900, top: 52, width: 900},
      header: {bottom: 112, height: 72, left: 0, right: 900, top: 40, width: 900},
      overlays: [{bottom: 120, height: 32, left: 200, right: 600, top: 88, width: 400}],
      placement: "inside",
      stage: {bottom: 800, height: 760, left: 0, right: 900, top: 40, width: 900},
    })).toEqual(expect.arrayContaining([
      "header is not horizontally inset",
      "header height changed",
      "content overlaps header",
      "top overlay overlaps header",
    ]));
  });

  test("rejects stage movement across a visual state change", () => {
    const before = {bottom: 900, height: 860, left: 372, right: 1260, top: 40, width: 888};
    expect(validateStableLayoutBox(before, {...before})).toEqual([]);
    expect(validateStableLayoutBox(before, {...before, height: 840, top: 60})).toEqual([
      "stage top changed",
      "stage height changed",
    ]);
  });
});
