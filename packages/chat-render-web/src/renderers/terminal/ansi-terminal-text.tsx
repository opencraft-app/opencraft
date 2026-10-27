import { typographyRegistry } from "@opencraft/design-system/typography";
import type { CSSProperties, ReactNode } from "react";

export interface AnsiTerminalSegment {
  readonly text: string;
  readonly style: CSSProperties | undefined;
}

interface AnsiState {
  background: string | null;
  foreground: string | null;
  bold: boolean;
  dim: boolean;
  hidden: boolean;
  italic: boolean;
  reverse: boolean;
  strike: boolean;
  underline: boolean;
}

const NORMAL_COLORS = [
  "#1f2328", "#cf222e", "#1a7f37", "#9a6700",
  "#0969da", "#8250df", "#1b7c83", "#f6f8fa",
] as const;
const BRIGHT_COLORS = [
  "#57606a", "#ff7b72", "#3fb950", "#d29922",
  "#58a6ff", "#bc8cff", "#39c5cf", "#ffffff",
] as const;

function initialAnsiState(): AnsiState {
  return {
    background: null,
    foreground: null,
    bold: false,
    dim: false,
    hidden: false,
    italic: false,
    reverse: false,
    strike: false,
    underline: false,
  };
}

function ansi256Color(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 8) return NORMAL_COLORS[index] ?? null;
  if (index < 16) return BRIGHT_COLORS[index - 8] ?? null;
  if (index < 232) {
    const cube = index - 16;
    const levels = [0, 95, 135, 175, 215, 255] as const;
    const red = levels[Math.floor(cube / 36)] ?? 0;
    const green = levels[Math.floor((cube % 36) / 6)] ?? 0;
    const blue = levels[cube % 6] ?? 0;
    return `rgb(${red} ${green} ${blue})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray} ${gray} ${gray})`;
}

function applyExtendedColor(
  parameters: readonly number[],
  index: number,
): readonly [string | null, number] {
  const mode = parameters[index + 1];
  if (mode === 5) return [ansi256Color(parameters[index + 2] ?? -1), index + 2];
  if (mode === 2) {
    const red = parameters[index + 2];
    const green = parameters[index + 3];
    const blue = parameters[index + 4];
    if ([red, green, blue].every((value) => value !== undefined && value >= 0 && value <= 255)) {
      return [`rgb(${red} ${green} ${blue})`, index + 4];
    }
  }
  return [null, index];
}

function applySgr(state: AnsiState, parameters: readonly number[]): AnsiState {
  let next = { ...state };
  const values = parameters.length === 0 ? [0] : parameters;
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index] ?? 0;
    if (code === 0) next = initialAnsiState();
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.reverse = true;
    else if (code === 8) next.hidden = true;
    else if (code === 9) next.strike = true;
    else if (code === 21) next.bold = false;
    else if (code === 22) { next.bold = false; next.dim = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.reverse = false;
    else if (code === 28) next.hidden = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.foreground = NORMAL_COLORS[code - 30] ?? null;
    else if (code >= 90 && code <= 97) next.foreground = BRIGHT_COLORS[code - 90] ?? null;
    else if (code === 39) next.foreground = null;
    else if (code >= 40 && code <= 47) next.background = NORMAL_COLORS[code - 40] ?? null;
    else if (code >= 100 && code <= 107) next.background = BRIGHT_COLORS[code - 100] ?? null;
    else if (code === 49) next.background = null;
    else if (code === 38 || code === 48) {
      const [color, consumedThrough] = applyExtendedColor(values, index);
      if (code === 38) next.foreground = color;
      else next.background = color;
      index = consumedThrough;
    }
  }
  return next;
}

function styleFor(state: AnsiState): CSSProperties | undefined {
  const foreground = state.reverse ? state.background : state.foreground;
  const background = state.reverse ? state.foreground : state.background;
  const decorations = [state.underline ? "underline" : null, state.strike ? "line-through" : null].filter(Boolean);
  const style: CSSProperties = {
    ...(foreground === null ? {} : { color: foreground }),
    ...(background === null ? {} : { backgroundColor: background }),
    ...(state.bold ? { fontWeight: typographyRegistry.weights.bold } : {}),
    ...(state.dim ? { opacity: 0.5 } : {}),
    ...(state.hidden ? { visibility: "hidden" } : {}),
    ...(state.italic ? { fontStyle: "italic" } : {}),
    ...(decorations.length === 0 ? {} : { textDecoration: decorations.join(" ") }),
  };
  return Object.keys(style).length === 0 ? undefined : style;
}

/** Applies terminal carriage-return overwrite semantics before ANSI tokenizing. */
export function normalizeTerminalOutput(value: string): string {
  let output = value.replace(/\r+\n/gu, "\n");
  while (/\r./u.test(output)) {
    output = output.replace(/^([^\r\n]*)\r+([^\r\n]+)/gmu, (_match, previous: string, replacement: string) => (
      replacement + previous.slice(replacement.length)
    ));
  }
  let previous = "";
  while (previous !== output) {
    previous = output;
    output = output.replace(/[^\n]\x08/gu, "");
  }
  return output;
}

export function parseAnsiTerminalOutput(value: string): readonly AnsiTerminalSegment[] {
  const source = normalizeTerminalOutput(value);
  const segments: AnsiTerminalSegment[] = [];
  const pattern = /\x1b\[([0-9;]*)m/gu;
  let state = initialAnsiState();
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) segments.push({ text: source.slice(cursor, index), style: styleFor(state) });
    const parameters = (match[1] ?? "").split(";").filter(Boolean).map((part) => Number.parseInt(part, 10));
    state = applySgr(state, parameters);
    cursor = index + match[0].length;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), style: styleFor(state) });
  return segments;
}

export function AnsiTerminalText({ children }: { readonly children: string }): ReactNode {
  return parseAnsiTerminalOutput(children).map((segment, index) => (
    <span key={`${index}:${segment.text.length}`} style={segment.style}>{segment.text}</span>
  ));
}
