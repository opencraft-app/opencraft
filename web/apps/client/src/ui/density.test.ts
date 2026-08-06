import {
  density,
  densityMode,
  densityScale,
  resolveDensityMode,
  text,
  textScale,
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

describe("type scale", () => {
  it("keeps both tiers describing the same groups", () => {
    expect(Object.keys(textScale.pointer).sort()).toEqual(
      Object.keys(textScale.touch).sort(),
    );
  });

  it("sets every pointer group in smaller type than its touch counterpart", () => {
    const notTightened = Object.keys(textScale.touch).filter((group) => {
      const key = group as keyof typeof textScale.touch;
      return textScale.pointer[key].fontSize >= textScale.touch[key].fontSize;
    });

    expect(notTightened).toEqual([]);
  });

  it("never tightens interface type below a legible floor", () => {
    // 10px is the smallest size this interface uses for real prose; anything
    // under it belongs to badges and glyphs, which do not live in this scale.
    const illegible = Object.entries(textScale.pointer)
      .filter(([, metrics]) => metrics.fontSize < 10)
      .map(([group]) => group);

    expect(illegible).toEqual([]);
  });

  it("keeps line height between the glyph height and double it", () => {
    const tiers = [textScale.pointer, textScale.touch];
    const broken = tiers.flatMap((tier) =>
      Object.entries(tier)
        .filter(([, { fontSize, lineHeight }]) => {
          const ratio = lineHeight / fontSize;
          return ratio < 1 || ratio > 2.2;
        })
        .map(([group]) => group),
    );

    expect(broken).toEqual([]);
  });

  it("feeds the typography roles that carry conversation copy", () => {
    const { typography } = velaTheme.semantic;

    expect(typography.messageBody.fontSize).toBe(text.message.fontSize);
    expect(typography.body.fontSize).toBe(text.body.fontSize);
    expect(typography.pageTitle.lineHeight).toBe(text.pageTitle.lineHeight);
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
      density.shelfRowMinHeight,
    );
    expect(desktopWorkspace.railWidth).toBe(density.railWidth);
  });

  it("hangs both pane headers off one band height", () => {
    // The chat header stacks a channel name over a description and stood at
    // 52/80; the management header carries a single title and stood at 48/64.
    // Two heights meant the chrome line jumped as you moved between tabs.
    // Converging upward keeps the two-line case uncramped and only gives the
    // one-line case more air.
    expect(velaTheme.recipes.desktopWorkspace.headerHeight).toBe(
      density.headerHeight,
    );
    expect(velaTheme.recipes.managementWorkspace.headerHeight).toBe(
      density.headerHeight,
    );
  });

  it("sizes every list shelf row off one role", () => {
    // Channels, direct messages and the management collection are the same
    // two-line row in the same 312pt shelf. They agreed at 44 on a pointer
    // and had drifted to 56, 64 and 64 on touch.
    const { conversationWorkspace, desktopWorkspace, managementWorkspace } =
      velaTheme.recipes;

    expect([
      conversationWorkspace.directRowMinHeight,
      desktopWorkspace.conversationRowMinHeight,
      managementWorkspace.rowMinHeight,
    ]).toEqual([
      density.shelfRowMinHeight,
      density.shelfRowMinHeight,
      density.shelfRowMinHeight,
    ]);
  });
});
