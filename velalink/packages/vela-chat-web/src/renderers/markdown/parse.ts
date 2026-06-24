import { lexer, type Token } from "marked";

export type MarkedToken = Token;

const MARKED_OPTIONS = {
  async: false,
  breaks: false,
  gfm: true,
  pedantic: false,
  silent: true,
} as const;

export function parseMarkdownTokens(markdown: string): MarkedToken[] {
  return Array.from(lexer(markdown, MARKED_OPTIONS));
}

