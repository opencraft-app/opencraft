import { describe, expect, it } from "vitest";

import type { CronRunRecord } from "@/lib/hermes-cron-client";
import { getScenarioTaskPack, SCENARIO_TASK_PACKS } from "../scenario-packs";
import {
  buildOneShotSchedule,
  buildScenarioTaskDraft,
  formatScenarioDeliverLabel,
  findScenarioPreviewRun,
  normalizeScenarioDeliverTarget,
} from "../scenario-task-builder";

function makeRun(overrides: Partial<CronRunRecord>): CronRunRecord {
  return {
    id: "run-1",
    job_id: "job-1",
    job_name: "试跑 - 每日新闻",
    job_prompt: "",
    schedule: { kind: "once", expr: "2026-07-02T09:02", display: "2026-07-02T09:02" },
    deliver: "local",
    run_at: "2026-07-02T01:03:00.000Z",
    status: "ok",
    output_path: "/home/agentuser/.hermes/cron/output/job-1/result.md",
    ...overrides,
  };
}

describe("scenario task builder", () => {
  it("builds drafts for all four launch scenarios", () => {
    const now = new Date(2026, 6, 2, 9, 0, 0);

    for (const pack of SCENARIO_TASK_PACKS) {
      const draft = buildScenarioTaskDraft({ pack, values: {}, now });

      expect(draft.scenarioId).toBe(pack.id);
      expect(draft.generatedName).toBe(pack.name);
      expect(draft.oneShotJobName).toBe(`试跑 - ${pack.name}`);
      expect(draft.generatedPrompt.length).toBeGreaterThan(80);
      expect(draft.generatedDeliver).toBe("local");
      expect(draft.oneShotSchedule).toBe("2026-07-02T09:00:05");
      expect(draft.recurringSchedule).toBe(pack.defaultSchedule);
    }
  });

  it("keeps the stock brief inside the non-investment-advice boundary", () => {
    const pack = getScenarioTaskPack("stock-morning-brief");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        focusScope: "自选股 + 行业板块",
        watchlist: "AI 算力、半导体、600519",
        style: "偏风险提醒",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("非投资建议");
    expect(draft.generatedPrompt).not.toContain("买入");
    expect(draft.generatedPrompt).not.toContain("卖出");
  });

  it("does not add LightVela inspiration content to the AI digest", () => {
    const pack = getScenarioTaskPack("ai-digest");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        focusArea: "Agent / 模型 / 开源",
        purpose: "产品判断",
        depth: "快讯 + 影响说明",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("Agent");
    expect(draft.generatedPrompt).not.toContain("LightVela");
    expect(draft.generatedPrompt).not.toContain("启发");
  });

  it("explicitly guides realtime scenarios to use bounded Hermes tools", () => {
    for (const pack of SCENARIO_TASK_PACKS) {
      const draft = buildScenarioTaskDraft({
        pack,
        values: {},
        now: new Date(2026, 6, 2, 9, 0, 0),
      });

      expect(draft.generatedPrompt).toContain("datetime");
      expect(draft.generatedPrompt).toContain("web_search");
      expect(draft.generatedPrompt).toContain("web_fetch");
      expect(draft.generatedPrompt).toContain("最多检索 3 组关键词");
      expect(draft.generatedPrompt).toContain("最多打开 4 个网页来源");
      expect(draft.generatedPrompt).toContain("保留来源名称或链接");
    }
  });

  it("asks the World Cup brief to fast-fail when there is no active tournament context", () => {
    const pack = getScenarioTaskPack("world-cup-daily");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {},
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("先确认当前是否处于世界杯比赛期");
    expect(draft.generatedPrompt).toContain("暂停任务建议");
  });

  it("builds a one-shot schedule after the requested current time", () => {
    expect(buildOneShotSchedule(new Date(2026, 6, 2, 9, 0, 30))).toBe("2026-07-02T09:00:35");
  });

  it("keeps selected scan-code channels as the Cron deliver target", () => {
    const pack = getScenarioTaskPack("world-cup-daily");

    expect(buildScenarioTaskDraft({
      pack,
      values: {},
      deliver: "weixin",
      now: new Date(2026, 6, 2, 9, 0, 0),
    })).toMatchObject({
      generatedDeliver: "weixin",
      generatedDeliverLabel: "微信",
    });

    expect(buildScenarioTaskDraft({
      pack,
      values: {},
      deliver: "qqbot",
      now: new Date(2026, 6, 2, 9, 0, 0),
    })).toMatchObject({
      generatedDeliver: "qqbot",
      generatedDeliverLabel: "QQ",
    });

    expect(normalizeScenarioDeliverTarget("feishu")).toBe("local");
    expect(formatScenarioDeliverLabel("local")).toBe("网页 / 最近执行");
  });

  it("matches preview runs by job name first, then prompt fallback", () => {
    const pack = getScenarioTaskPack("daily-news");
    const draft = buildScenarioTaskDraft({
      pack,
      values: { categories: "国内 / 国际 / 科技", density: "10 条标准", stance: "尽量中立" },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    const promptFallbackRun = makeRun({
      id: "prompt-run",
      job_name: "renamed job",
      job_prompt: draft.generatedPrompt,
      run_at: "2026-07-02T01:04:00.000Z",
    });
    const nameRun = makeRun({
      id: "name-run",
      job_name: draft.oneShotJobName,
      job_prompt: "older prompt",
      run_at: "2026-07-02T01:03:00.000Z",
    });

    expect(findScenarioPreviewRun(draft, [promptFallbackRun], Date.parse("2026-07-02T01:00:00.000Z"))?.id).toBe("prompt-run");
    expect(findScenarioPreviewRun(draft, [promptFallbackRun, nameRun], Date.parse("2026-07-02T01:00:00.000Z"))?.id).toBe("name-run");
  });

  it("ignores stale recent runs from before preview creation", () => {
    const pack = getScenarioTaskPack("world-cup-daily");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {},
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(findScenarioPreviewRun(draft, [
      makeRun({
        id: "stale",
        job_name: draft.oneShotJobName,
        run_at: "2026-07-01T23:59:00.000Z",
      }),
    ], Date.parse("2026-07-02T01:00:00.000Z"))).toBeNull();
  });
});
