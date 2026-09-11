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

  it("keeps initial instance creation blank and defers Hermes profile access", () => {
    const source = readSource("src/contexts/agent-context.tsx");

    expect(source).toContain("const isInitialInstanceCreation = created.id === (created.instanceId ?? created.id);");
    expect(source).toMatch(/if \(!isInitialInstanceCreation\) \{[\s\S]*repositories\.bots\.updateBotProfile/);
    expect(source).not.toContain("const isInitialBotCreation = bots.length === 0;");
  });

  it("wires Pass resolution state into the Bot quota exposed by the provider", () => {
    const source = readSource("src/contexts/agent-context.tsx");

    expect(source).toContain("const [hasResolvedPasses, setHasResolvedPasses] = useState(false);");
    expect(source).toContain("setHasResolvedPasses(true);");
    expect(source).toContain("maxBots: resolveBotQuotaForPassState(activePass, hasResolvedPasses)");
  });
});
