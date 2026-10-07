/** Strip directives/actions so the renderer retains theme and interaction ownership. */
export function prepareMermaidSource(source: string): string {
  return source
    .replace(/%%\{[\s\S]*?\}%%/gu, "")
    .replace(/^\s*click\s+.*$/gimu, "")
    .trim();
}
