import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Agent common settings region boundary", () => {
  it("adds the navigation entry and panel only for the domestic site", () => {
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");

    expect(page).toContain('id: "settings" as const');
    expect(page).toContain('!isGlobal && activeSection === "settings"');
    expect(page).toContain("<AgentCommonSettingsPanel");
  });

  it("excludes settings from global static params and direct access", () => {
    const route = readSource("src/app/(site)/agents/[section]/page.next.tsx");

    expect(route).toContain("isGlobal ? section !== 'settings' : section !== 'websites'");
    expect(route).toContain("(isGlobal && sectionId === 'settings')");
  });
});
