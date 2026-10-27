import { highlightChatCodeHtml, type CodeHighlightTheme } from "@opencraft/chat-render-react/code-highlight";

import { unwrapHighlightedCodeHtml } from "./highlighted-code-html";
export type { CodeHighlightTheme };

export async function highlightCode(
  code: string,
  languageName: string | null,
  theme: CodeHighlightTheme,
  signal: AbortSignal,
): Promise<string> {
  return unwrapHighlightedCodeHtml(await highlightChatCodeHtml(code, languageName, theme, signal));
}
