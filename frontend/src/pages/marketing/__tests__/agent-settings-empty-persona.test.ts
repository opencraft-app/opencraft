import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("empty Agent page", () => {
  it("removes the brand frame on root and named Agent pages without a Bot", () => {
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");
    const styles = readSource("src/styles.css");
    const header = readSource("next-site/agents-page-client.tsx");
    const consoleLayout = readSource("next-site/agents-console-layout.tsx");
    const emptyGuard = page.split("const isEmptyAgentPage = ")[1]?.split(";")[0];

    expect(consoleLayout).toContain("<AgentsPageClient initialSectionSlug={route.slug} sectionId={route.sectionId} />");
    expect(emptyGuard).not.toContain("initialSectionSlug");
    for (const state of ["!isModifying", "!passesLoading", "!isCreating", "!botsLoading", "visibleBots.length === 0"]) {
      expect(emptyGuard).toContain(state);
    }
    expect(page).toContain('isEmptyAgentPage && "lv-agent-empty-page"');
    expect(styles).toMatch(/header\.lv-agent-sidebar-header:has\(\+ :is\(\.lv-agent-empty-page, \.lv-agent-upgrading-page\)\)\s*\{\s*border-right: 0;\s*border-bottom: 0 !important;/);
    expect(header).toContain("className={isWorkbench ? undefined : 'lv-agent-sidebar-header'}");
  });

  it("removes the brand frame while a plan upgrade replaces the Agent sidebar", () => {
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");

    expect(page).toContain('isModifying && "lv-agent-upgrading-page"');
  });

  it("calls the first Bot an AI companion in English", () => {
    const translations = JSON.parse(readSource("src/i18n/generated/en-US.json")) as Record<string, string>;
    expect(translations.k_40a58d40).toBe("Create your own AI companion");
  });
});
