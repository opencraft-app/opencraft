import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Agent settings navigation groups", () => {
  const readNavigationSource = () => {
    const page = readFileSync(
      join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
      "utf8",
    );
    const settingsGroupsStart = page.indexOf("const settingsGroups");
    const settingsGroupsEnd = page.indexOf("const isRestartDisabled");

    expect(settingsGroupsStart).toBeGreaterThanOrEqual(0);
    expect(settingsGroupsEnd).toBeGreaterThan(settingsGroupsStart);

    return page.slice(settingsGroupsStart, settingsGroupsEnd);
  };

  it("orders the task-oriented groups as setup, use, growth, and manage", () => {
    const settingsGroups = readNavigationSource();
    const labels = ['t("配置")', 't("使用")', 't("成长")', 't("管理")'];
    const indexes = labels.map((label) => settingsGroups.indexOf(label));

    indexes.forEach((index) => expect(index).toBeGreaterThanOrEqual(0));
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
  });

  it("places every visible section in its approved group", () => {
    const settingsGroups = readNavigationSource();
    const setupStart = settingsGroups.indexOf('id: "setup"');
    const useStart = settingsGroups.indexOf('id: "use"');
    const growthStart = settingsGroups.indexOf('id: "growth"');
    const manageStart = settingsGroups.indexOf('id: "manage"');

    [setupStart, useStart, growthStart, manageStart].forEach((index) => {
      expect(index).toBeGreaterThanOrEqual(0);
    });

    const setup = settingsGroups.slice(setupStart, useStart);
    const use = settingsGroups.slice(useStart, growthStart);
    const growth = settingsGroups.slice(growthStart, manageStart);
    const manage = settingsGroups.slice(manageStart);

    expect(setup).toMatch(/id: "channel"[\s\S]*id: "model"[\s\S]*id: "skill"/);
    expect(use).toMatch(/id: "chat"[\s\S]*id: "automations"[\s\S]*id: "website"/);
    expect(growth).toMatch(/id: "buddy"[\s\S]*id: "memory"[\s\S]*id: "achievement"/);
    expect(manage).toMatch(/id: "files"[\s\S]*id: "diagnostics"[\s\S]*id: "settings"/);
  });

  it("keeps the My creations navigation entry behind show()", () => {
    const settingsGroups = readNavigationSource();

    expect(settingsGroups).toMatch(/isGlobal\s*&&\s*showHiddenAgentTools[\s\S]*id: "website"/);
  });

  it("keeps the website panel directly reachable after hiding its navigation entry", () => {
    const page = readFileSync(
      join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
      "utf8",
    );

    expect(page).toContain('isGlobal && activeSection === "website"');
  });

});
