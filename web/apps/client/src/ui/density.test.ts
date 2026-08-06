import {
  density,
  densityMode,
  densityScale,
  resolveDensityMode,
  velaTheme,
} from "./tokens";

/**
 * Density is the one token dimension that has to satisfy two incompatible
 * masters: Apple's 44pt touch minimum and macOS' far tighter pointer metrics.
 * These assertions pin the rules rather than the numbers, so retuning the
 * ladder stays cheap while the guarantees stay intact.
 */

/** The smallest comfortable touch target, in points. */
const TOUCH_TARGET_MINIMUM = 44;

/** Roles a finger actually lands on, as opposed to rows and containers. */
const touchTargets = [
  "collectionActionHeight",
  "controlHeight",
  "fieldHeight",
  "headerActionHeight",
  "switcherOptionMinHeight",
] as const;

describe("density resolution", () => {
  it("keeps native platforms on touch regardless of media queries", () => {
    const fine = () => ({ matches: true });

    expect(resolveDensityMode("ios", fine)).toBe("touch");
    expect(resolveDensityMode("android", fine)).toBe("touch");
  });

  it("gives the web a pointer density only when the pointer is fine", () => {
    expect(resolveDensityMode("web", () => ({ matches: true }))).toBe("pointer");
    expect(resolveDensityMode("web", () => ({ matches: false }))).toBe("touch");
  });

  it("asks specifically about pointer fineness, not viewport width", () => {
    const queries: string[] = [];
    resolveDensityMode("web", (query) => {
      queries.push(query);
      return { matches: true };
    });

    expect(queries).toEqual(["(pointer: fine)"]);
  });

  it("falls back to touch where matchMedia is unavailable", () => {
    expect(resolveDensityMode("web", undefined)).toBe("touch");
  });
});

describe("density scale", () => {
  it("keeps both tiers describing the same set of roles", () => {
    expect(Object.keys(densityScale.pointer).sort()).toEqual(
      Object.keys(densityScale.touch).sort(),
    );
  });

  it("holds every touch target at or above the 44pt minimum", () => {
    const undersized = touchTargets.filter(
      (role) => densityScale.touch[role] < TOUCH_TARGET_MINIMUM,
    );

    expect(undersized).toEqual([]);
  });

  it("makes the pointer tier strictly tighter on every role", () => {
    const notTightened = Object.keys(densityScale.touch).filter((role) => {
      const key = role as keyof typeof densityScale.touch;
      return densityScale.pointer[key] >= densityScale.touch[key];
    });

    expect(notTightened).toEqual([]);
  });

  it("does not tighten any role past half of its touch size", () => {
    // A pointer affordance may be small, but it still has to be aimable.
    const overTightened = Object.keys(densityScale.touch).filter((role) => {
      const key = role as keyof typeof densityScale.touch;
      return densityScale.pointer[key] < densityScale.touch[key] / 2;
    });

    expect(overTightened).toEqual([]);
  });
});

describe("density wiring", () => {
  it("points the active tier at the mode it reports", () => {
    expect(density).toBe(densityScale[densityMode]);
  });

  it("follows the density override the suite was started with", () => {
    // `npm run test:density` reruns this whole suite at pointer density; the
    // rest of the assertions in the repo have to survive both runs.
    const override = process.env.VELA_DENSITY_MODE;
    const expected =
      override === "pointer" || override === "touch" ? override : "touch";

    expect(densityMode).toBe(expected);
  });

  it("feeds the recipes that drive the shell frame", () => {
    const { control, desktopWorkspace } = velaTheme.recipes;

    expect(control.height).toBe(density.controlHeight);
    expect(desktopWorkspace.headerHeight).toBe(density.headerHeight);
    expect(desktopWorkspace.conversationRowMinHeight).toBe(
      density.conversationRowMinHeight,
    );
    expect(desktopWorkspace.railWidth).toBe(density.railWidth);
  });
});
