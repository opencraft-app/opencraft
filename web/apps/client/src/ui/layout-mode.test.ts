import { layoutMode as nativeLayoutMode } from "./layout-mode.native";
import { layoutMode as webLayoutMode } from "./layout-mode.web";

describe("web layoutMode", () => {
  it.each([
    [320, "compact"],
    [899, "compact"],
    [1_024, "compact"],
    [1_099, "compact"],
    [1_100, "compact"],
    [1179, "compact"],
    [1180, "wide"],
    [1920, "wide"],
  ] as const)("maps width %s to %s", (width, expected) => {
    expect(webLayoutMode(width)).toBe(expected);
  });
});

describe("native layoutMode", () => {
  it.each([
    [390, "compact"],
    [699, "compact"],
    [700, "compact"],
    [1_024, "compact"],
    [1_099, "compact"],
    [1_100, "compact"],
    [1179, "compact"],
    [1180, "wide"],
  ] as const)("maps width %s to %s", (width, expected) => {
    expect(nativeLayoutMode(width)).toBe(expected);
  });
});
