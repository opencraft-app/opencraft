import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

describe("Agents route loading boundary", () => {
  it("uses the standard black primary treatment for the login gate action", () => {
    const source = readSource("next-site/app-route-shell.tsx");
    const loginGate = source.slice(
      source.indexOf("{t('请先登录')}"),
      source.indexOf("<LegalFooter />"),
    );

    expect(loginGate).toContain("bg-black/90");
    expect(loginGate).toContain("hover:bg-black/80");
    expect(loginGate).toContain("focus-visible:ring-black/30");
    expect(loginGate).not.toContain('className="lw-btn-primary"');
    expect(loginGate).toContain("{t('登录后即可创建和管理你的 Agent')}");
    expect(loginGate).not.toContain("Hermes Agent");
  });

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
    expect(source).toContain(
      "const loadingFallback = isWorkbench ? productHeader : <AgentsRouteLoading collapsed={collapsed} onToggle={toggle} isChat={!sectionId || sectionId === 'chat'} />;",
    );
    expect(source).toContain(
      "<AppRouteShell loadingFallback={loadingFallback} showAuthGateFooter={false}>",
    );
    expect(source).toContain("<Suspense fallback={loadingFallback}>");
    expect(source).toContain("{productHeader}");
    expect(source).toContain("showLanguageSwitcher={false}");

    const loadingShell = readSource("next-site/app-route-shell.tsx");
    const agentsLoading = loadingShell.slice(
      loadingShell.indexOf("export function AgentsRouteLoading"),
      loadingShell.indexOf("export function AccountRouteLoading"),
    );
    expect(agentsLoading).toContain("showLanguageSwitcher={false}");
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
