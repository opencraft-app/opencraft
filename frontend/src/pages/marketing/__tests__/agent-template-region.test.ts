import { describe, expect, it } from "vitest";

import {
  __TEMPLATE_DEFS_FOR_TEST as DEFS,
  resolveTemplatesForRegion,
} from "@/pages/marketing/agent-demo-templates";

/**
 * 模板的区域适配守卫。
 *
 * 两站技能市场不是同一套：
 *   - 国际站：clawhub / skills.sh（`acli skills-sh install`）
 *   - 国内站：SkillHub（`acli skills install`），没有 skills-sh，也没有
 *     Hermes 官方 optional-skills 的 GitHub 拉取通道
 * 把国际站技能原样搬到国内站会安装失败，所以这里逐条守住。
 *
 * isCN 是编译期常量，单个测试进程只看得到一个区域 —— 因此统一走
 * resolveTemplatesForRegion 显式传入区域，两边都能覆盖。
 */
describe("template region adaptation", () => {
  const cnTemplates = resolveTemplatesForRegion(DEFS, true);
  const globalTemplates = resolveTemplatesForRegion(DEFS, false);

  it("never ships skills.sh or GitHub skills to the domestic site", () => {
    for (const tpl of cnTemplates) {
      for (const skill of tpl.skills) {
        expect(skill.skillsShId, `${tpl.id} -> ${skill.slug}`).toBeUndefined();
        expect(skill.githubSource, `${tpl.id} -> ${skill.slug}`).toBeUndefined();
      }
    }
  });

  it("keeps the international site on its own registries", () => {
    const intlSkills = globalTemplates.flatMap((tpl) => tpl.skills);
    // 国际站至少仍有 skills.sh 与 GitHub 两类来源，证明覆盖没有反向污染
    expect(intlSkills.some((s) => s.skillsShId)).toBe(true);
    expect(intlSkills.some((s) => s.githubSource)).toBe(true);
  });

  it("overrides routines whenever skills change, so prompts never name a missing skill", () => {
    for (const def of DEFS) {
      if (!def.cn) continue;
      const before = def.skills.map((s) => s.slug).join(",");
      const after = def.cn.skills.map((s) => s.slug).join(",");
      if (before === after) continue;
      // 技能换了，任务说明必须跟着换 —— 否则会让 Agent 去找一个不存在的技能
      expect(def.cn.routines, `${def.id} must override routines`).toBeDefined();
      expect(def.cn.routines.length).toBeGreaterThan(0);
    }
  });

  it("does not reference removed skills in domestic prompts", () => {
    // 这些是国际站专属技能名，不该出现在国内站的任务说明里
    const intlOnly = ["research Skill", "teach Skill", "marketing-ideas", "social-content", "stocks skill"];
    for (const tpl of cnTemplates) {
      const prompts = tpl.routines.map((r) => r.desc).join("\n");
      for (const name of intlOnly) {
        expect(prompts, `${tpl.id} mentions ${name}`).not.toContain(name);
      }
    }
  });

  it("keeps every domestic prompt aligned with the skills it actually has", () => {
    for (const tpl of cnTemplates) {
      if (tpl.skills.length > 0) continue;
      // 没配技能的模板，任务说明不该出现「如果已安装 ... Skill」这类引导
      const prompts = tpl.routines.map((r) => r.desc).join("\n");
      expect(prompts, `${tpl.id} has no skills but mentions one`).not.toMatch(/已安装.{0,20}Skill/);
    }
  });

  it("keeps routines non-empty on both sites", () => {
    for (const list of [cnTemplates, globalTemplates]) {
      for (const tpl of list) {
        expect(tpl.routines.length, `${tpl.id}`).toBeGreaterThan(0);
      }
    }
  });
});
