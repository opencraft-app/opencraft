import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

describe("OpenClawProvider local preview backend boundary", () => {
  it("tries to load real backend bots before falling back to the local preview bot", () => {
    const source = readSource("src/contexts/agent-context.tsx");

    expect(source).toMatch(/if \(LOCAL_PREVIEW_AUTH_ENABLED && session\.authReady\) \{/);
    expect(source).toMatch(/void refreshBots\(\);/);
    expect(source).toMatch(/setBots\(\(prev\) => \(prev\.length > 0 \? prev : \[buildLocalPreviewBot\(\)\]\)\)/);
    expect(source).not.toMatch(/LOCAL_PREVIEW_AUTH_ENABLED && session\.authReady[\s\S]{0,200}setBots\(\(prev\) => \(prev\.length > 0 \? prev : \[buildLocalPreviewBot\(\)\]\)\);[\s\S]{0,80}\} else if \(isAuthenticated/);
  });
});
