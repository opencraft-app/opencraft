import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("empty persona page", () => {
  it("removes the brand frame only after the persona route reaches the no-Bot state", () => {
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");
    const styles = readSource("src/styles.css");
    const header = readSource("next-site/agents-page-client.tsx");
    const emptyGuard = page.split("const isEmptyPersonaPage = ")[1]?.split(";")[0];

    expect(emptyGuard).toContain('activeSection === "buddy"');
    for (const state of ["!isModifying", "!passesLoading", "!isCreating", "!botsLoading", "visibleBots.length === 0"]) {
      expect(emptyGuard).toContain(state);
    }
    expect(page).toContain('isEmptyPersonaPage && "lv-agent-empty-persona-page"');
    expect(styles).toMatch(/header\.lv-agent-sidebar-header:has\(\+ \.lv-agent-empty-persona-page\)\s*\{\s*border-right: 0;\s*border-bottom: 0 !important;/);
    expect(header).toContain("className={isWorkbench ? undefined : 'lv-agent-sidebar-header'}");
  });

  it("calls the first Bot an AI companion in English", () => {
    const translations = JSON.parse(readSource("src/i18n/generated/en-US.json")) as Record<string, string>;
    expect(translations.k_40a58d40).toBe("Create your own AI companion");
  });
});
