import {
  STYLE_LAB_DENSITIES,
  STYLE_LAB_INTERACTION_STATES,
  STYLE_LAB_THEMES,
  STYLE_LAB_VISUAL_BASELINES,
  buildStyleLabMatrix,
} from "./style-lab-model";
import {statSync} from "node:fs";
import {join} from "node:path";

describe("style lab review matrix", () => {
  it("covers both appearances, both input densities, and every control state", () => {
    expect(STYLE_LAB_THEMES).toEqual(["light", "dark"]);
    expect(STYLE_LAB_DENSITIES).toEqual(["pointer", "touch"]);
    expect(STYLE_LAB_INTERACTION_STATES).toEqual([
      "idle",
      "hovered",
      "focused",
      "pressed",
      "disabled",
    ]);
    expect(buildStyleLabMatrix()).toHaveLength(20);
  });

  it("keeps real-page screenshot baselines for both ends of the review matrix", () => {
    expect(STYLE_LAB_VISUAL_BASELINES).toHaveLength(2);
    for (const baseline of STYLE_LAB_VISUAL_BASELINES) {
      const file = join(
        __dirname,
        "..",
        "features",
        "stylelab",
        "__screenshots__",
        baseline.fileName,
      );
      expect(statSync(file).size).toBeGreaterThan(50_000);
    }
  });
});
