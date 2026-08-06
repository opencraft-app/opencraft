import {
  breakpoints,
  computerSupportStackBreakpoint,
  velaTheme,
} from "./theme";
import { interfaceFontFamilies, palette } from "./tokens";

/**
 * These assertions describe the *shape and relationships* the theme has to
 * keep, never the concrete values it happens to carry today. Recolouring or
 * retuning the scale must not turn this suite red; breaking the layering
 * rules must.
 */

const colorPattern = /^(?:#[0-9A-Fa-f]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/u;

type Numeric = Record<string, number>;

function numericLeaves(value: unknown, trail: string[] = []): Array<[string, number]> {
  if (typeof value === "number") return [[trail.join("."), value]];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      numericLeaves(child, [...trail, key]),
    );
  }
  return [];
}

function ascending(values: number[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

/** Reduces a colour to its `r,g,b` channels so a hue and its alpha variants match. */
function channelsOf(color: string): string | null {
  const hex = /^#([0-9A-Fa-f]{6})$/u.exec(color);
  if (hex) {
    const value = Number.parseInt(hex[1]!, 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255].join(",");
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^)]*)?\)$/u.exec(color);
  return rgb ? [rgb[1], rgb[2], rgb[3]].join(",") : null;
}

describe("Vela theme contract", () => {
  it("does not expose the retired flat token namespaces", () => {
    expect(velaTheme).not.toHaveProperty("colors");
    expect(velaTheme).not.toHaveProperty("fonts");
    expect(velaTheme).not.toHaveProperty("radii");
    expect(velaTheme).not.toHaveProperty("sizes");
  });

  it("expresses every semantic color as a resolvable color value", () => {
    const invalid = Object.entries(velaTheme.semantic.color).filter(
      ([, value]) => !colorPattern.test(value),
    );

    expect(invalid).toEqual([]);
  });

  it("sources every semantic color from the palette", () => {
    // A role may either name a palette entry outright or derive a translucent
    // variant of one. Anything else is a literal that a recolour would miss.
    const paletteValues = new Set<string>(Object.values(palette));
    const paletteChannels = new Set(
      Object.values(palette)
        .map(channelsOf)
        .filter((channels): channels is string => channels !== null),
    );
    const unsourced = Object.entries(velaTheme.semantic.color)
      .filter(([, value]) => {
        if (paletteValues.has(value)) return false;
        const channels = channelsOf(value);
        return channels === null || !paletteChannels.has(channels);
      })
      .map(([role]) => role);

    expect(unsourced).toEqual([]);
  });

  it("keeps the spacing scale positive and strictly increasing", () => {
    const steps = Object.values(velaTheme.spacing);

    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step > 0)).toBe(true);
    expect(ascending(steps)).toBe(true);
  });

  it("gives every typography style a family, a size and a roomier line height", () => {
    const broken = Object.entries(velaTheme.semantic.typography).filter(
      ([, style]) => {
        const { fontFamily, fontSize, lineHeight } = style as {
          fontFamily?: string;
          fontSize?: number;
          lineHeight?: number;
        };
        return (
          typeof fontFamily !== "string" ||
          fontFamily.length === 0 ||
          typeof fontSize !== "number" ||
          fontSize <= 0 ||
          typeof lineHeight !== "number" ||
          lineHeight < fontSize
        );
      },
    );

    expect(broken.map(([name]) => name)).toEqual([]);
  });

  it("keeps radii non-negative with the fully round roles on top", () => {
    const radius = velaTheme.semantic.radius as Numeric;
    const values = Object.values(radius);
    const round = Math.max(radius.circle!, radius.pill!);

    expect(values.every((value) => value >= 0)).toBe(true);
    expect(values.every((value) => value <= round)).toBe(true);
  });

  it("keeps the shadow ladder monotonic from card to overlay", () => {
    const ladder = [
      velaTheme.shadows.card,
      velaTheme.shadows.floatingControl,
      velaTheme.shadows.overlay,
    ];

    expect(
      ladder.every(
        (shadow, index) =>
          index === 0 ||
          (shadow.radius >= ladder[index - 1]!.radius &&
            shadow.offsetY >= ladder[index - 1]!.offsetY),
      ),
    ).toBe(true);
    expect(ladder.every((shadow) => colorPattern.test(shadow.color))).toBe(true);
  });

  it("keeps z-index layers strictly increasing", () => {
    expect(ascending(Object.values(velaTheme.semantic.layer))).toBe(true);
  });

  it("keeps interaction opacities in range and timings positive", () => {
    const interaction = velaTheme.semantic.interaction as Numeric;
    const fractional = ["disabledOpacity", "pressedScale", "pressedScaleSubtle"];

    for (const [key, value] of Object.entries(interaction)) {
      expect(Number.isFinite(value)).toBe(true);
      if (fractional.includes(key)) {
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(1);
      } else {
        expect(value).toBeGreaterThan(0);
      }
    }

    for (const duration of Object.values(velaTheme.semantic.motion)) {
      expect(duration).toBeGreaterThan(0);
    }
  });

  it("keeps every recipe value a finite number", () => {
    const nonFinite = numericLeaves(velaTheme.recipes).filter(
      ([, value]) => !Number.isFinite(value),
    );

    expect(nonFinite).toEqual([]);
  });

  it("does not let the recipe namespace keep growing", () => {
    // `recipes` exists for geometry shared across components. It drifted into
    // a dictionary of named one-offs (`viewportChromeOffset`, `brandHighlightOffsetX`)
    // because the lint rules used to forbid literals in components. Those rules
    // are relaxed now, so this ceiling replaces them: one-off geometry belongs
    // in its component, and anything added here has to displace something.
    const namespaces = Object.keys(velaTheme.recipes);
    const leaves = numericLeaves(velaTheme.recipes);

    expect(namespaces.length).toBeLessThanOrEqual(16);
    expect(leaves.length).toBeLessThanOrEqual(142);
  });

  it("keeps the terminal surface legible and self-consistent", () => {
    const { terminal } = velaTheme;

    expect(colorPattern.test(terminal.surface)).toBe(true);
    expect(colorPattern.test(terminal.text)).toBe(true);
    expect(colorPattern.test(terminal.cursor)).toBe(true);
    expect(terminal.textStyle.fontSize).toBeGreaterThan(0);
    expect(terminal.textStyle.lineHeight).toBeGreaterThanOrEqual(
      terminal.textStyle.fontSize,
    );
    expect(terminal.scrollbackLines).toBeGreaterThan(0);
    expect(terminal.initialRows).toBeGreaterThan(0);
  });

  it("keeps the interface font stack layered rather than pinned", () => {
    expect(interfaceFontFamilies.native.length).toBeGreaterThan(0);
    // A CJK family must be reachable and the stack must end in a generic.
    expect(interfaceFontFamilies.web).toMatch(/PingFang|Hiragino|Noto Sans/u);
    expect(interfaceFontFamilies.web.trim()).toMatch(
      /(?:sans-serif|system-ui)$/u,
    );
  });

  it("anchors breakpoints at zero and keeps them distinct", () => {
    const values = Object.values(breakpoints);

    expect(breakpoints.compact).toBe(0);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value) => Number.isFinite(value) && value >= 0)).toBe(
      true,
    );
    expect(computerSupportStackBreakpoint).toBeGreaterThan(breakpoints.medium);
  });
});
