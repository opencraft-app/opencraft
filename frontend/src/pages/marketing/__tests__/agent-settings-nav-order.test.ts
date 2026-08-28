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

  it("orders the task-oriented groups as setup, use, growth, manage, and labs", () => {
    const settingsGroups = readNavigationSource();
    const labels = ['t("配置")', 't("使用")', 't("成长")', 't("管理")', 't("实验室")'];
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
    const labsStart = settingsGroups.indexOf('id: "labs"');

    [setupStart, useStart, growthStart, manageStart, labsStart].forEach((index) => {
      expect(index).toBeGreaterThanOrEqual(0);
    });

    const setup = settingsGroups.slice(setupStart, useStart);
    const use = settingsGroups.slice(useStart, growthStart);
    const growth = settingsGroups.slice(growthStart, manageStart);
    const manage = settingsGroups.slice(manageStart, labsStart);
    const labs = settingsGroups.slice(labsStart);

    expect(setup).toMatch(/id: "channel"[\s\S]*id: "model"[\s\S]*id: "skill"/);
    // 「对话」菜单项已移除：入口改由侧边栏顶部「对话/设置」双 tab 承担（sidebar-tabs 改造）。
    expect(use).toMatch(/id: "automations"[\s\S]*id: "website"/);
    expect(use).not.toContain('id: "chat"');
    expect(growth).toMatch(/id: "buddy"[\s\S]*id: "memory"[\s\S]*id: "achievement"/);
    expect(manage).toMatch(/id: "files"[\s\S]*id: "diagnostics"[\s\S]*id: "settings"/);
    expect(manage).not.toContain('id: "labs"');
    expect(labs).toMatch(/id: "labs"[\s\S]*id: "deepseek-harness"/);
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
