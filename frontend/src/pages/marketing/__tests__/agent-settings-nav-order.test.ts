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

  it("orders the navigation groups as daily, growth, management, and labs", () => {
    const settingsGroups = readNavigationSource();
    const labels = ['t("日常")', 't("成长")', 't("管理")', 't("实验室")'];
    const indexes = labels.map((label) => settingsGroups.indexOf(label));

    indexes.forEach((index) => expect(index).toBeGreaterThanOrEqual(0));
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    expect(settingsGroups).toContain('id: "manage"');
  });

  it("places every visible section in its approved group", () => {
    const settingsGroups = readNavigationSource();
    const dailyStart = settingsGroups.indexOf('id: "daily"');
    const growthStart = settingsGroups.indexOf('id: "growth"');
    const manageStart = settingsGroups.indexOf('id: "manage"');
    const labsStart = settingsGroups.indexOf('id: "labs"');

    [dailyStart, growthStart, manageStart, labsStart].forEach((index) => {
      expect(index).toBeGreaterThanOrEqual(0);
    });

    const daily = settingsGroups.slice(dailyStart, growthStart);
    const growth = settingsGroups.slice(growthStart, manageStart);
    const manage = settingsGroups.slice(manageStart, labsStart);
    const labs = settingsGroups.slice(labsStart);

    expect(daily).toMatch(/id: "channel"[\s\S]*id: "skill"[\s\S]*id: "connectors"[\s\S]*id: "automations"/);
    expect(daily).not.toContain('id: "model"');
    expect(daily).not.toContain('id: "website"');
    expect(growth.match(/id: "(buddy|memory|achievement)"/g)).toEqual([
      'id: "buddy"',
      'id: "memory"',
      'id: "achievement"',
    ]);
    expect(growth).toContain('label: t("持久记忆")');
    expect(growth).not.toContain('id: "diagnostics"');
    expect(manage).toMatch(/id: "model"[\s\S]*id: "diagnostics"[\s\S]*id: "settings"/);
    expect(manage).toContain('label: t("高级设置")');
    expect(labs).toMatch(/id: "website"[\s\S]*id: "deepseek-harness"/);
  });

  it("keeps the achievements navigation route and panel wiring intact", () => {
    const page = readFileSync(
      join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
      "utf8",
    );
    const routes = readFileSync(
      join(process.cwd(), "src/lib/agent-routes.ts"),
      "utf8",
    );

    expect(routes).toContain('achievement: `${AGENTS_HOME_PATH}/achievements`');
    expect(routes).toContain('achievements: "achievement"');
    expect(page).toContain('import("@/pages/marketing/agent-achievements-panel")');
    expect(page).toContain('activeSection === "achievement"');
    expect(page).toContain('<AchievementsPanel botId={activeBot.id} botName={activeBot.name} />');
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
