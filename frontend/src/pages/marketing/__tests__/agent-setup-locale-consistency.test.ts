/*
 * 创建链路的语言一致性守卫。
 *
 * 真实故障：国际站订阅后，创建表单是英文 → 点「创建」进配置进度页突然全是
 * 中文 → 再到总览页变成中英混杂。三段界面属于同一条流程，语言却不一致。
 *
 * 三个成因各不相同，所以分别守：
 *   1. buildBuddySetupPlan 的步骤 label 硬编码中文，不走 t()
 *   2. 模板 routine.label 改成英文后，cron 解析器只认中文 → 定时任务静默全失败
 *   3. 总览页「最新动态」是模块级常量，中文直接渲染、日期整串硬编码
 */
import { describe, expect, it } from "vitest";

import { buildBuddySetupPlan, toCronExpression } from "@/pages/marketing/agent-buddy-setup";
import {
  __TEMPLATE_DEFS_FOR_TEST as DEFS,
  resolveTemplatesForRegion,
} from "@/pages/marketing/agent-demo-templates";

const profile = { name: "Test Bot", description: "" };
const HAS_CJK = /[\u4e00-\u9fff]/;

describe("setup plan labels follow the injected locale", () => {
  it("passes every label through t()", () => {
    const seen: string[] = [];
    const plan = buildBuddySetupPlan({
      profile,
      template: resolveTemplatesForRegion(DEFS, false)[1],
      profileId: "p1",
      timestamp: "2026-09-20",
      // 假 t：把收到的 key 记下来，并返回可辨识的译文
      t: (zh, options) => {
        seen.push(zh);
        const label = String((options as { label?: string })?.label ?? "");
        const name = String((options as { name?: string })?.name ?? "");
        return `[EN]${zh}${name}${label}`;
      },
    });

    expect(plan.length).toBeGreaterThan(0);
    /*
     * 每一条 label 都必须来自 t() —— 漏一条，国际站用户就会在英文清单里
     * 看到一行中文。
     */
    for (const step of plan) {
      expect(step.label.startsWith("[EN]"), `${step.kind} 的 label 没走 t()`).toBe(true);
    }
    // 插值而非字符串拼接：英文语序才能正确（"Installing skill X"）
    expect(seen).toContain("正在安装技能 {{name}}");
    expect(seen).toContain("正在创建定时任务 {{label}}");
  });

  it("falls back to the original text when no t is given", () => {
    // 不传 t 时回显中文，保证纯函数在非组件环境（测试/脚本）下可用
    const plan = buildBuddySetupPlan({
      profile, profileId: "p1", timestamp: "2026-09-20",
    });
    expect(plan[0]!.label).toBe("正在写入 Bot 人设");
  });
});

describe("cron parsing covers both locales", () => {
  const cases: [string, string][] = [
    // 中文（国内站模板）
    ["每天 21:30", "30 21 * * *"],
    ["工作日 09:00", "0 9 * * 1-5"],
    ["每周日 20:00", "0 20 * * 0"],
    ["每周一 10:00", "0 10 * * 1"],
    ["每 6 小时", "0 */6 * * *"],
    ["每 30 分钟", "*/30 * * * *"],
    // 英文（国际站模板）
    ["Daily 21:30", "30 21 * * *"],
    ["Weekdays 09:00", "0 9 * * 1-5"],
    ["Sundays 20:00", "0 20 * * 0"],
    ["Mondays 10:00", "0 10 * * 1"],
    ["Every 6 hours", "0 */6 * * *"],
    ["Every 30 minutes", "*/30 * * * *"],
  ];

  it.each(cases)("parses %s", (label, expected) => {
    expect(toCronExpression(label)).toBe(expected);
  });

  /*
   * 这条是核心回归守卫。
   *
   * 英文化模板时只改了 routine.label，没动 cron 解析器 —— 结果国际站 8 个
   * 定时任务全部解析失败（返回 null → 调用方跳过该步），用户看不到任何报错，
   * 只是创建完发现一个任务都没有。
   */
  it("builds a cron step for every routine in both regions", () => {
    for (const useCN of [true, false]) {
      for (const tpl of resolveTemplatesForRegion(DEFS, useCN)) {
        const plan = buildBuddySetupPlan({
          profile, template: tpl, profileId: "p1", timestamp: "2026-09-20",
        });
        const cronSteps = plan.filter((step) => step.kind === "cron");
        expect(
          cronSteps.length,
          `${useCN ? "国内站" : "国际站"} ${tpl.id}: `
          + `${tpl.routines.length} 条 routine 只生成了 ${cronSteps.length} 个定时任务，`
          + `无法解析的 label: ${tpl.routines
            .filter((r) => !toCronExpression(r.label)).map((r) => r.label).join(", ")}`,
        ).toBe(tpl.routines.length);
      }
    }
  });
});

describe("overview changelog is localizable", () => {
  it("keeps dates structured instead of hardcoding a formatted string", () => {
    // 日期整串（「2026年9月10日」）进词典意味着每加一条动态都要翻 6 个语种；
    // 结构化后由 Intl.DateTimeFormat 按 locale 输出
    const src = readOverviewSource();
    expect(src).toMatch(/date: \{ y: \d{4}, m: \d{1,2}, d: \d{1,2} \}/);
    expect(src).toContain("Intl.DateTimeFormat(locale");
    expect(src).not.toMatch(/date: "\d{4}年/);
  });

  it("renders changelog text through t()", () => {
    const src = readOverviewSource();
    // 标题 / 正文 / 图片 alt / 指示器 aria-label 四处都要翻译
    expect(src).toContain("{t(entry.title)}");
    expect(src).toContain("{t(entry.body)}");
    expect(src).toContain("alt={t(entry.imageAlt)}");
    expect(src).toContain("aria-label={t(item.title)}");
  });
});

function readOverviewSource(): string {
  // 用源码断言而不是渲染：changelog 是模块级常量，渲染测试只能覆盖当前
  // locale 下的一种结果，反而看不出「有没有走 t()」这个结构性问题
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync("src/pages/marketing/agent-overview-panel.tsx", "utf8");
}

describe("template routine labels match the cron parser", () => {
  it("never ships an unparseable label", () => {
    for (const def of DEFS) {
      const variants = [
        { label: "base", routines: def.routines },
        ...(def.cn ? [{ label: "cn", routines: def.cn.routines ?? [] }] : []),
        ...(def.en ? [{ label: "en", routines: def.en.routines ?? [] }] : []),
      ];
      for (const variant of variants) {
        for (const routine of variant.routines) {
          expect(
            toCronExpression(routine.label),
            `${def.id}.${variant.label}: "${routine.label}" 解析不出 cron，`
            + "该任务会被静默跳过（见 toCronExpression 支持的形式）",
          ).not.toBeNull();
        }
      }
    }
  });

  it("keeps international labels free of Chinese", () => {
    for (const tpl of resolveTemplatesForRegion(DEFS, false)) {
      for (const routine of tpl.routines) {
        expect(HAS_CJK.test(routine.label), `${tpl.id} routine.label 含中文`).toBe(false);
      }
    }
  });
});
