import { describe, expect, it } from "vitest";

import { DEMO_TEMPLATES } from "@/pages/marketing/agent-demo-templates";
import { buildBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup";

/**
 * 模板可执行性核验。
 *
 * 目的不是测某个函数，而是守住「模板里写的东西在真实环境里跑得起来」：
 *   1. 技能安装命令必须落在平台真实支持的通道上
 *   2. 技能 slug 必须能与 hermes 已安装列表对上（否则 UI 显示未安装、agent 也难引用）
 *   3. 每条 routine 必须能解析成合法 cron
 *   4. 不得引入需要额外全局 CLI 的技能
 */
describe("template runnability", () => {
  const profile = { name: "n", tags: "", description: "" };

  /** 已知需要额外全局 CLI 的技能 —— 不该出现在模板里 */
  const NEEDS_EXTRA_CLI = ["defuddle", "agent-browser"];

  it("has no skill that requires an extra global CLI", () => {
    for (const tpl of DEMO_TEMPLATES) {
      for (const skill of tpl.skills) {
        expect(NEEDS_EXTRA_CLI, `${tpl.id} -> ${skill.slug}`).not.toContain(skill.slug);
      }
    }
  });

  it("keeps slug equal to the last segment of the skills.sh id", () => {
    // mergeInstalledWithHermes 按 slug 匹配 registry 列表与 hermes 列表，
    // 不一致会导致「装上了但显示未安装」
    for (const tpl of DEMO_TEMPLATES) {
      for (const skill of tpl.skills) {
        if (!skill.skillsShId) continue;
        expect(skill.slug, `${tpl.id} -> ${skill.skillsShId}`)
          .toBe(skill.skillsShId.split("/").pop());
      }
    }
  });

  it("builds a runnable command for every skill and routine", () => {
    for (const tpl of DEMO_TEMPLATES) {
      const steps = buildBuddySetupPlan({ profile, template: tpl, timestamp: "t" });

      const skillSteps = steps.filter((s) => s.kind === "skill");
      expect(skillSteps, `${tpl.id} skills`).toHaveLength(tpl.skills.length);
      for (const step of skillSteps) {
        expect(step.command.length).toBeGreaterThan(0);
      }

      const cronSteps = steps.filter((s) => s.kind === "cron");
      expect(cronSteps, `${tpl.id} routines`).toHaveLength(tpl.routines.length);
      for (const step of cronSteps) {
        // 必须解析出 5 段合法 cron，而不是退化成兜底值
        const m = /hermes(?: -p '[^']+')? cron create '([^']+)'/.exec(step.command);
        expect(m, `${tpl.id} cron expr`).not.toBeNull();
        expect(m![1]!.trim().split(/\s+/), `${tpl.id} -> ${m![1]}`).toHaveLength(5);
      }
    }
  });

  it("dumps the full plan for manual review", () => {
    for (const tpl of DEMO_TEMPLATES) {
      const steps = buildBuddySetupPlan({ profile, template: tpl, timestamp: "t" });
      console.log(`\n=== ${tpl.name} (${tpl.id}) ===`);
      for (const s of steps) {
        if (s.kind === "skill") {
          const ch = s.command.includes("skills-sh") ? "skills.sh"
            : s.command.includes("codeload.github.com") ? "github"
              : "skillhub";
          console.log(`  skill[${ch}] ${s.label}`);
        }
        if (s.kind === "cron") {
          const m = /hermes(?: -p '[^']+')? cron create '([^']+)'/.exec(s.command);
          console.log(`  cron  ${m ? m[1] : "??"}  <- ${s.label}`);
        }
      }
    }
  });
});
