import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

describe("Agents route loading boundary", () => {
  it("defers authenticated Agent surfaces until the auth gate renders them", () => {
    const source = readSource("next-site/agents-page-client.tsx");

    expect(source).not.toContain(
      "import { AgentSettingsPage } from '@/pages/marketing/agent-settings-page';",
    );
    expect(source).not.toContain(
      "import { AgentsWorkbenchPage } from '@/pages/marketing/agents-workbench/AgentsWorkbenchPage';",
    );
    expect(source).toContain('lazy(() => import(\'@/pages/marketing/agent-settings-page\')');
    expect(source).toContain(
      "lazy(() => import('@/pages/marketing/agents-workbench/AgentsWorkbenchPage')",
    );
    expect(source).toContain("<Suspense fallback={loadingFallback}>");
  });

  it("loads only the selected settings panel instead of bundling every panel upfront", () => {
    const source = readSource("src/pages/marketing/agent-settings-page.tsx");

    for (const panelPath of [
      "agent-buddy-panel",
      "agent-skills-panel",
      "agent-achievements-panel",
      "agent-automations-panel",
    ]) {
      expect(source).not.toMatch(
        new RegExp(`^import .*${panelPath}`, "m"),
      );
      expect(source).toContain(`import("@/pages/marketing/${panelPath}")`);
    }
  });

  it("leaves the initial Pass refresh owned by AgentProvider", () => {
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");
    const provider = readSource("src/contexts/agent-context.tsx");

    expect(page).not.toContain(
      "useEffect(() => { void refreshPasses(); }, [refreshPasses]);",
    );
    expect(provider).toContain("void refreshBots();\n        void refreshPasses();");
  });
});
