function escapeHtml(source: string): string {
  return source.replace(/[&<>]/gu, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    return "&gt;";
  });
}

export function unwrapHighlightedCodeHtml(html: string): string {
  const codeStart = html.indexOf("<code");
  if (codeStart < 0) return "";
  const contentStart = html.indexOf(">", codeStart);
  const contentEnd = html.lastIndexOf("</code>");
  if (contentStart < 0 || contentEnd < contentStart) return "";
  return html.slice(contentStart + 1, contentEnd);
}

/** Keep the last highlighted prefix mounted while the unhighlighted stream tail grows. */
export function appendUnhighlightedCodeTail(
  highlightedCode: string,
  highlightedHtml: string,
  code: string,
): string {
  if (!code.startsWith(highlightedCode)) return "";
  return highlightedHtml + escapeHtml(code.slice(highlightedCode.length));
}
