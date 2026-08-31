import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Agent settings navigation groups", () => {
  const readGeneratedDictionary = (locale: string): Record<string, string> =>
    JSON.parse(
      readFileSync(join(process.cwd(), `src/i18n/generated/${locale}.json`), "utf8"),
    ) as Record<string, string>;

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

    expect(setup).toMatch(/id: "channel"[\s\S]*id: "model"/);
    expect(setup).not.toContain('id: "skill"');
    // 「对话」菜单项已移除：入口改由侧边栏顶部「探索/对话」双 tab 承担（sidebar-tabs 改造）。
    expect(use).toMatch(/id: "skill"[\s\S]*id: "automations"/);
    expect(use).not.toContain('id: "website"');
    expect(use).not.toContain('id: "chat"');
    expect(growth).toMatch(/id: "buddy"[\s\S]*id: "memory"[\s\S]*id: "achievement"/);
    expect(manage).toMatch(/id: "files"[\s\S]*id: "diagnostics"[\s\S]*id: "settings"/);
    expect(manage).not.toContain('id: "labs"');
    expect(labs).toMatch(/id: "website"[\s\S]*id: "deepseek-harness"/);
  });

  it("工作台导航入口默认显示，不再需要 show() 解锁", () => {
    const settingsGroups = readNavigationSource();

    expect(settingsGroups).toContain('id: "website"');
    expect(settingsGroups).not.toMatch(/isGlobal\s*&&\s*showHiddenAgentTools/);
  });

  it("将工作台导航标记为当前用户的个人工作台", () => {
    const settingsGroups = readNavigationSource();
    const labsStart = settingsGroups.indexOf('id: "labs"');
    const labs = settingsGroups.slice(labsStart);

    expect(labs).toContain('label: t("我的工作台")');
    expect(labs).not.toContain('label: t("工作台")');
  });

  it("将我的工作台英文文案翻译为单数 My Workbench", () => {
    const translationKey = readGeneratedDictionary("zh-to-key")["我的工作台"];

    expect(translationKey).toBeDefined();
    expect(readGeneratedDictionary("en-US")[translationKey!]).toBe("My Workbench");
  });

  it("将我的工作台西班牙语文案翻译为单数 Mi espacio de trabajo", () => {
    const translationKey = readGeneratedDictionary("zh-to-key")["我的工作台"];

    expect(translationKey).toBeDefined();
    expect(readGeneratedDictionary("es")[translationKey!]).toBe("Mi espacio de trabajo");
  });

  it("工作台面板直接按 activeSection 渲染（不再受 isGlobal 限制）", () => {
    const page = readFileSync(
      join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
      "utf8",
    );

    expect(page).toContain('activeSection === "website"');
    expect(page).not.toContain('isGlobal && activeSection === "website"');
  });

});
