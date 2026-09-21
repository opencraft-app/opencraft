/*
 * 模板文案的区域覆盖守卫。
 *
 * 背景：模板不是 UI 文案，而是会真实写进 bot 的数据 —— instructions 落进
 * SOUL.md、memories 落进 USER.md、routines 的 desc 落进定时任务提示词。
 * 所以它们不走 i18n 词典，而是用 en 覆盖层跟技能配置成套维护。
 *
 * 真实故障：国际站上模板卡片和详情弹窗里全是中文（UI 壳是英文），因为
 * 基础定义是硬编码中文且没有任何英文覆盖。
 */
import { describe, expect, it } from "vitest";

import {
  __TEMPLATE_DEFS_FOR_TEST as DEFS,
  resolveTemplatesForRegion,
} from "@/pages/marketing/agent-demo-templates";

const HAS_CJK = /[\u4e00-\u9fff]/;

const globalTemplates = resolveTemplatesForRegion(DEFS, false);
const cnTemplates = resolveTemplatesForRegion(DEFS, true);

describe("template locale coverage", () => {
  it("ships no Chinese text to the international site", () => {
    expect(globalTemplates.length).toBeGreaterThan(0);

    for (const tpl of globalTemplates) {
      // 卡片与弹窗直接展示的字段
      expect(HAS_CJK.test(tpl.name), `${tpl.id}.name 仍是中文`).toBe(false);
      expect(HAS_CJK.test(tpl.description), `${tpl.id}.description 仍是中文`).toBe(false);
      /*
       * instructions / memories 会写进 SOUL.md 与 USER.md，routines.desc 会
       * 成为定时任务的提示词 —— 它们决定 bot 用什么语言回应，不只是展示。
       */
      expect(HAS_CJK.test(tpl.instructions), `${tpl.id}.instructions 仍是中文`).toBe(false);
      for (const memory of tpl.memories) {
        expect(HAS_CJK.test(memory), `${tpl.id}.memories 含中文: ${memory}`).toBe(false);
      }
      for (const routine of tpl.routines) {
        expect(HAS_CJK.test(routine.label), `${tpl.id} routine.label 含中文`).toBe(false);
        expect(HAS_CJK.test(routine.desc), `${tpl.id} routine.desc 含中文`).toBe(false);
      }
      for (const skill of tpl.skills) {
        expect(HAS_CJK.test(skill.name), `${tpl.id} skill.name 含中文`).toBe(false);
        expect(HAS_CJK.test(skill.desc), `${tpl.id} skill.desc 含中文`).toBe(false);
      }
    }
  });

  it("keeps the domestic site in Chinese", () => {
    // 反向确认 en 覆盖没有泄漏到国内站
    const names = cnTemplates.map((tpl) => tpl.name);
    expect(names.some((name) => HAS_CJK.test(name))).toBe(true);
    expect(names).toContain("健康管家");
  });

  it("never lets en override break skill install identity", () => {
    /*
     * en.skills 只提供 name / desc。slug 与安装源必须保留基础定义的值 ——
     * 覆盖掉它们会导致安装失败（装不到或装错技能）。
     */
    for (const def of DEFS) {
      if (def.cnOnly || !def.en?.skills) continue;
      const resolved = globalTemplates.find((tpl) => tpl.id === def.id);
      expect(resolved, `${def.id} 应出现在国际站`).toBeDefined();
      resolved!.skills.forEach((skill, index) => {
        const base = def.skills[index]!;
        expect(skill.slug, `${def.id} skill[${index}].slug 被覆盖了`).toBe(base.slug);
        expect(skill.skillsShId).toBe(base.skillsShId);
        expect(skill.githubSource).toEqual(base.githubSource);
        expect(skill.installDir).toBe(base.installDir);
      });
    }
  });

  it("requires an en override for every internationally visible template", () => {
    // 新增模板时若忘了加 en，这条会点名是哪个
    for (const def of DEFS) {
      if (def.cnOnly) continue;
      expect(def.en, `${def.id} 缺少 en 覆盖，国际站会显示中文`).toBeDefined();
      expect(def.en!.name).toBeTruthy();
      expect(def.en!.instructions).toBeTruthy();
    }
  });
});
