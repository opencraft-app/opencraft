import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const coreRoot = resolve(process.cwd(), "../shared/lightvela-agent-core/src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("shared agent core boundary", () => {
  it("contains no renderer, transport, storage, analytics or product-presentation imports", () => {
    const source = sourceFiles(coreRoot).map((file) => readFileSync(file, "utf8")).join("\n");
    for (const forbidden of [
      /from ["']react(?:\/|["'])/,
      /from ["']next(?:\/|["'])/,
      /react-router/,
      /localStorage|sessionStorage|\bwindow\b|\bdocument\b/,
      /\bfetch\s*\(/,
      /Datong|PostHog|useTranslation|\buseT\b/,
    ]) expect(source).not.toMatch(forbidden);
  });
});
