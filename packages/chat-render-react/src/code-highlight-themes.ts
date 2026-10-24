import type { ThemeRegistration } from "@shikijs/core";

import opencraftDarkTokens from "./opencraft-dark-tokens.json";
import opencraftLightTokens from "./opencraft-light-tokens.json";

interface OpenCraftSyntaxPalette {
  readonly foreground: string;
  readonly comment: string;
  readonly string: string;
  readonly number: string;
  readonly regexp: string;
  readonly keyword: string;
  readonly variable: string;
  readonly parameter: string;
  readonly function: string;
}

export const OPENCRAFT_LIGHT_SYNTAX: OpenCraftSyntaxPalette = {
  foreground: "#0d0d0d",
  comment: "#666666",
  string: "#008809",
  number: "#0071EA",
  regexp: "#001BCB",
  keyword: "#D53538",
  variable: "#BD5800",
  parameter: "#666666",
  function: "#751ED9",
};

export const OPENCRAFT_DARK_SYNTAX: OpenCraftSyntaxPalette = {
  foreground: "#fcfcfc",
  comment: "#999999",
  string: "#85df7b",
  number: "#6DCBF4",
  regexp: "#3D8DFF",
  keyword: "#F67576",
  variable: "#FA994C",
  parameter: "#999999",
  function: "#B06DFF",
};

function createOpenCraftTheme(
  name: "opencraft-light" | "opencraft-dark",
  type: "light" | "dark",
  palette: OpenCraftSyntaxPalette,
): ThemeRegistration {
  return {
    name,
    type,
    colors: {
      "editor.background": type === "light" ? "#ffffff" : "#111111",
      "editor.foreground": palette.foreground,
    },
    fg: palette.foreground,
    bg: type === "light" ? "#ffffff" : "#111111",
    settings: type === "light" ? opencraftLightTokens : opencraftDarkTokens,
  };
}

export const opencraftLightTheme = createOpenCraftTheme("opencraft-light", "light", OPENCRAFT_LIGHT_SYNTAX);
export const opencraftDarkTheme = createOpenCraftTheme("opencraft-dark", "dark", OPENCRAFT_DARK_SYNTAX);
