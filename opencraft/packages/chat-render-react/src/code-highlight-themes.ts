import type { ThemeRegistration } from "@shikijs/core";

import codexDarkTokens from "./codex-dark-tokens.json";
import codexLightTokens from "./codex-light-tokens.json";

interface CodexSyntaxPalette {
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

export const CODEX_LIGHT_SYNTAX: CodexSyntaxPalette = {
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

export const CODEX_DARK_SYNTAX: CodexSyntaxPalette = {
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

function createCodexTheme(
  name: "codex-light" | "codex-dark",
  type: "light" | "dark",
  palette: CodexSyntaxPalette,
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
    settings: type === "light" ? codexLightTokens : codexDarkTokens,
  };
}

export const codexLightTheme = createCodexTheme("codex-light", "light", CODEX_LIGHT_SYNTAX);
export const codexDarkTheme = createCodexTheme("codex-dark", "dark", CODEX_DARK_SYNTAX);
