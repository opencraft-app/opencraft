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
    expect(manage).toMatch(/id: "files"[\s\S]*id: "diagnostics"/);
  });

  it("keeps group labels legible at the navigation text size", () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const labelStart = styles.indexOf(".lv-agents-nav-group-label");
    const labelEnd = styles.indexOf(".lv-agents-nav-group-items", labelStart);

    expect(labelStart).toBeGreaterThanOrEqual(0);
    expect(labelEnd).toBeGreaterThan(labelStart);
    expect(styles.slice(labelStart, labelEnd)).toContain("color: rgb(0 0 0 / 60%);");
  });

  it("uses compact density for second-level navigation items", () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const itemsStart = styles.indexOf(".lv-agents-nav-group-items");
    const itemsEnd = styles.indexOf(".lv-agents-nav-group .lv-agents-nav-item", itemsStart);
    const navItemStart = styles.indexOf(".lv-agents-nav-item {", itemsEnd);
    const navItemEnd = styles.indexOf(".lv-agents-nav-item.is-active", navItemStart);

    expect(itemsStart).toBeGreaterThanOrEqual(0);
    expect(itemsEnd).toBeGreaterThan(itemsStart);
    expect(navItemStart).toBeGreaterThan(itemsEnd);
    expect(navItemEnd).toBeGreaterThan(navItemStart);
    expect(styles.slice(itemsStart, itemsEnd)).toContain("gap: 2px;");
    expect(styles.slice(navItemStart, navItemEnd)).toContain("height: 36px;");
  });

  it("keeps revealed advanced tools in the responsive navigation grid", () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const mobileStart = styles.indexOf("@media (max-width: 720px)");
    const mobileEnd = styles.indexOf("@media (min-width: 768px)", mobileStart);

    expect(styles).toMatch(
      /@media \(max-width: 1023px\)[\s\S]*?\.lv-agents-nav \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/,
    );
    expect(mobileStart).toBeGreaterThanOrEqual(0);
    expect(mobileEnd).toBeGreaterThan(mobileStart);
    expect(styles.slice(mobileStart, mobileEnd)).toContain(".lv-agents-nav,");
    expect(styles.slice(mobileStart, mobileEnd)).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr));",
    );
  });
});
