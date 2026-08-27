import { describe, expect, it } from "vitest";

import { buildCreateCommand, type CronRunRecord } from "@/lib/hermes-cron-client";
import { getOverviewScenarioTaskPacks, getScenarioTaskPack, SCENARIO_CATEGORIES, SCENARIO_TASK_PACKS } from "../scenario-packs";
import {
  buildScenarioTaskConfigSummary,
  buildOneShotSchedule,
  buildScenarioTaskDraft,
  formatScenarioDeliverLabel,
  findScenarioPreviewRun,
  isScenarioRecurringJobName,
  normalizeScenarioDeliverTarget,
  parseOneShotSchedule,
} from "../scenario-task-builder";

function makeRun(overrides: Partial<CronRunRecord>): CronRunRecord {
  return {
    id: "run-1",
    job_id: "job-1",
    job_name: "每日新闻 · 单次执行",
    job_prompt: "",
    skills: [],
    schedule: { kind: "once", expr: "2026-07-02T09:02", display: "2026-07-02T09:02" },
    deliver: "local",
    run_at: "2026-07-02T01:03:00.000Z",
    status: "ok",
    output_path: "/home/agentuser/.hermes/cron/output/job-1/result.md",
    ...overrides,
  };
}

describe("scenario task builder", () => {
  it("builds drafts for all focused launch scenarios", () => {
    const now = new Date(2026, 6, 2, 9, 0, 0);

    for (const pack of SCENARIO_TASK_PACKS) {
      const draft = buildScenarioTaskDraft({ pack, values: {}, now });

      expect(draft.scenarioId).toBe(pack.id);
      expect(draft.generatedName).toContain(pack.name);
      expect(draft.oneShotJobName).toBe(`${draft.generatedName} · 单次执行`);
      expect(draft.generatedPrompt.length).toBeGreaterThan(80);
      expect(draft.generatedPrompt).toContain("请把输出写成可以直接发送给用户的最终消息");
      expect(draft.generatedPrompt).toContain("不要输出 job_id、Cronjob、HTTP 状态码");
      expect(draft.generatedPrompt).toContain("cron deliver 会自动投递最终响应");
      expect(draft.generatedPrompt).toContain("不主动添加随机抖动");
      expect(draft.generatedPrompt).toContain("lastRunAtMs / nextRunAtMs / createdAtMs");
      expect(draft.generatedDeliver).toBe("local");
      if (draft.runMode === "one-shot") {
        expect(draft.oneShotSchedule).not.toBe("");
        expect(draft.recurringSchedule.split(/\s+/)).toHaveLength(5);
      } else {
        expect(draft.oneShotSchedule).toBe("2026-07-02T09:00:05");
        expect(draft.recurringSchedule.split(/\s+/)).toHaveLength(5);
      }
    }
  });

  it("keeps the exchange-rate alert inside the non-investment-advice boundary", () => {
    const pack = getScenarioTaskPack("country-fx-alert");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        fromCurrency: "人民币 CNY",
        toCurrency: "美元 USD",
        usageScenario: "出境旅行/留学",
        threshold: "USD/CNY 低于 7.20 提醒我",
        actionMode: "只提醒，不给交易建议",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("不构成投资建议");
    expect(draft.generatedPrompt).toContain("不给买入、卖出、换汇时机等投资建议");
    expect(draft.generatedPrompt).not.toContain("建议买入");
    expect(draft.generatedPrompt).not.toContain("建议卖出");
  });

  it("does not guess local position for weather warning alerts", () => {
    const pack = getScenarioTaskPack("weather-warning-alert");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        region: "深圳",
        warningTypes: "暴雨|台风",
        alertLevel: "黄色及以上提醒，橙色/红色加急",
        impactContext: "通勤和接送",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("具体关注位置：深圳。");
    expect(draft.generatedPrompt).toContain("官方预警类型：暴雨 / 台风。");
    expect(draft.generatedPrompt).toContain("不自动猜测用户位置");
    expect(draft.generatedPrompt).toContain("优先检索官方气象台");
  });

  it("explicitly guides realtime scenarios to use bounded Hermes tools", () => {
    const realtimePackIds = [
      "country-fx-alert",
      "ai-hot-daily",
      "deep-research-watch",
      "weather-warning-alert",
      "global-holiday-reminder",
      "flight-departure-once",
    ] as const;
    for (const packId of realtimePackIds) {
      const pack = getScenarioTaskPack(packId);
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

  it("uses five-field Hermes cron expressions for business-day scenario schedules", () => {
    expect(getScenarioTaskPack("todo-focus-brief").defaultSchedule).toBe("0 9 * * 1-5");

    for (const packId of ["todo-focus-brief"] as const) {
      const fields = getScenarioTaskPack(packId).defaultSchedule.split(/\s+/);
      expect(fields).toHaveLength(5);
      expect(fields[4]).toBe("1-5");
    }
  });

  it("uses the reminder time edited by the user for every recurring overview task", () => {
    for (const packId of [
      "rent-reminder",
      "country-fx-alert",
      "global-holiday-reminder",
      "stock-info-digest",
    ] as const) {
      const draft = buildScenarioTaskDraft({
        pack: getScenarioTaskPack(packId),
        values: { reminderTime: "16:45" },
        now: new Date(2026, 6, 2, 9, 0, 0),
      });

      expect(draft.recurringDailyTimes, packId).toEqual(["16:45"]);
      expect(draft.recurringSchedule, packId).toBe("45 16 * * *");
      expect(draft.generatedPrompt, packId).toContain("提醒时间：16:45。");
    }
  });

  it("builds English protocol prompts for English overview tasks", () => {
    const pack = getOverviewScenarioTaskPacks("en-US").find((item) => item.id === "rent-reminder");
    expect(pack).toBeTruthy();

    const draft = buildScenarioTaskDraft({
      pack: pack!,
      values: {},
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedName).toContain("Rent reminder");
    expect(draft.generatedPrompt).toContain("You are running a LightVela automation");
    expect(draft.generatedPrompt).toContain("Task name: Rent reminder");
    expect(draft.generatedPrompt).toContain("Output requirements:");
    expect(draft.generatedPrompt).not.toContain("你正在执行一个 LightVela 场景任务");
    expect(draft.generatedPrompt).not.toContain("输出要求：");
  });

  it("uses English field labels inside English overview task prompts", () => {
    const pack = getOverviewScenarioTaskPacks("en-US").find((item) => item.id === "rent-reminder");
    expect(pack).toBeTruthy();

    const draft = buildScenarioTaskDraft({
      pack: pack!,
      values: {
        rentInfo: "Internet bill, paid by bank transfer",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("User-provided details:");
    expect(draft.generatedPrompt).toContain("billing details: Internet bill, paid by bank transfer.");
    expect(draft.generatedPrompt).not.toContain("detail tagihan:");
  });

  it("uses Indonesian field labels inside Indonesian overview task prompts", () => {
    const pack = getOverviewScenarioTaskPacks("id-ID").find((item) => item.id === "rent-reminder");
    expect(pack).toBeTruthy();

    const draft = buildScenarioTaskDraft({
      pack: pack!,
      values: {
        rentInfo: "Tagihan internet, dibayar lewat transfer bank",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("Detail dari pengguna:");
    expect(draft.generatedPrompt).toContain("detail tagihan: Tagihan internet, dibayar lewat transfer bank.");
    expect(draft.generatedPrompt).not.toContain("billing details:");
  });

  it("builds fully Spanish protocol prompts for Spanish overview tasks", () => {
    const pack = getOverviewScenarioTaskPacks("es").find((item) => item.id === "rent-reminder");
    expect(pack).toBeTruthy();

    const draft = buildScenarioTaskDraft({
      pack: pack!,
      values: {
        rentInfo: "Factura de internet, pagada por transferencia bancaria",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.oneShotJobName).toBe(`${draft.generatedName} · ejecución única`);
    expect(draft.generatedPrompt).toContain("Estás ejecutando una automatización de LightVela");
    expect(draft.generatedPrompt).toContain("Nombre de la tarea: Recordatorio del alquiler");
    expect(draft.generatedPrompt).toContain("Requisitos de salida:");
    expect(draft.generatedPrompt).toContain("Detalles proporcionados por el usuario:");
    expect(draft.generatedPrompt).toContain(
      "detalles de facturación: Factura de internet, pagada por transferencia bancaria.",
    );
    expect(draft.generatedPrompt).toContain("aviso el día del vencimiento: sí.");
    expect(draft.generatedPrompt).not.toMatch(/[\u3400-\u9fff\uf900-\ufaff]/);
  });

  it("keeps Spanish realtime and safety instructions in Spanish", () => {
    const pack = getOverviewScenarioTaskPacks("es").find((item) => item.id === "country-fx-alert");
    expect(pack).toBeTruthy();

    const draft = buildScenarioTaskDraft({
      pack: pack!,
      values: {},
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("Reglas de consulta en tiempo real:");
    expect(draft.generatedPrompt).toContain("web_search, web_fetch");
    expect(draft.generatedPrompt).toContain("Nota de seguridad:");
    expect(draft.generatedPrompt).toContain("No constituye asesoramiento de inversión");
    expect(draft.generatedPrompt).not.toMatch(/[\u3400-\u9fff\uf900-\ufaff]/);
  });

  it("keeps every Spanish overview task draft free of Chinese fallback copy", () => {
    for (const pack of getOverviewScenarioTaskPacks("es")) {
      const draft = buildScenarioTaskDraft({
        pack,
        values: {},
        now: new Date(2026, 6, 2, 9, 0, 0),
      });

      expect(draft.oneShotJobName, pack.id).toContain("ejecución única");
      expect(draft.generatedPrompt, pack.id).not.toMatch(/[\u3400-\u9fff\uf900-\ufaff]/);
    }
  });

  it("formats scenario-specific field values for prompts", () => {
    const pack = getScenarioTaskPack("todo-focus-brief");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        taskInbox: "PRD 评审、Bug Bash",
        priorityRule: "先清理阻塞他人的事项",
        capacity: "上午 2 小时深度工作",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("用户配置：");
    expect(draft.generatedPrompt).toContain("任务池：PRD 评审、Bug Bash。");
    expect(draft.generatedPrompt).toContain("排序规则：先清理阻塞他人的事项。");
    expect(draft.generatedPrompt).toContain("今日可用时间：上午 2 小时深度工作。");
  });

  it("keeps unfinished workflow scenarios off the published shelf", () => {
    const publishedIds = SCENARIO_TASK_PACKS.map((pack) => pack.id);
    expect(publishedIds).not.toContain("automation-opportunity-scan");
    expect(publishedIds).not.toContain("interview-prep-once");
    expect(publishedIds).not.toContain("world-cup-daily");
    expect(publishedIds).not.toContain("wc-qualifier-reminder");
    expect(SCENARIO_TASK_PACKS.some((pack) => pack.category === "sports")).toBe(false);
  });

  it("keeps research scenarios runnable without unverified external skill ids", () => {
    const pack = getScenarioTaskPack("deep-research-watch");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        researchTopic: "AI Agent 在企业协同场景里的落地机会",
        sourcePreference: "官方文档|新闻报道",
        changeThreshold: "出现新产品/新数据/明显争议",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(pack.category).toBe("study");
    expect(draft.generatedPrompt).toContain("自动化执行方式");
    expect(draft.generatedPrompt).toContain("权威来源");
    expect(draft.generatedPrompt).toContain("研究主题：AI Agent 在企业协同场景里的落地机会。");
    expect(draft.skillIds).toEqual([]);
    expect(pack.skillSources).toBeUndefined();
  });

  it("keeps CBT counseling inside the support-not-treatment boundary", () => {
    const pack = getScenarioTaskPack("cbt-counseling");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {},
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("仅作心理支持与自我觉察");
    expect(draft.generatedPrompt).toContain("不替代专业医疗或心理治疗");
    expect(draft.generatedPrompt).toContain("实体抽取方式");
    expect(draft.generatedPrompt).toContain("触发事件、情绪词、自动想法");
  });

  it("builds a one-shot schedule after the requested current time", () => {
    expect(buildOneShotSchedule(new Date(2026, 6, 2, 9, 0, 30))).toBe("2026-07-02T09:00:35");
  });

  it("uses the configured trigger time for one-shot scenario tasks", () => {
    const pack = getScenarioTaskPack("flight-departure-once");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        flightDepartureAt: "2026-07-10 10:30",
        airport: "深圳宝安国际机场 T3",
        homeLocation: "深圳市南山区科技园",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(pack.runMode).toBe("one-shot");
    expect(draft.oneShotSchedule).toBe("2026-07-10T07:00:00");
    expect(draft.generatedPrompt).toContain("航班起飞时间：2026-07-10 10:30。");
    expect(draft.generatedPrompt).toContain("最晚出门时间");
  });

  it("lets medication switch between one-shot and recurring while shopping stays one-shot", () => {
    const medication = getScenarioTaskPack("medication-once");
    const shopping = getScenarioTaskPack("weekend-shopping-list");

    expect(medication.runMode).toBe("recurring");
    expect(medication.runModeFieldKey).toBe("reminderMode");
    expect(medication.oneShotRunModeValues).toContain("仅这一次");
    expect(medication.oneShotScheduleFieldKey).toBe("triggerAt");
    expect(shopping.runMode).toBe("one-shot");
    expect(shopping.oneShotScheduleFieldKey).toBe("triggerAt");
  });

  it("uses user-provided medication guides as the source for one-shot reminders", () => {
    const pack = getScenarioTaskPack("medication-once");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        medicine: "头孢克洛 1 粒，医生说饭后",
        sourceLinks: "https://example.com/drug-guide",
        sourceText: "用法用量：饭后服用。漏服请咨询医生。",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("用户资料使用方式");
    expect(draft.generatedPrompt).toContain("仅在需要时用 web_fetch 打开用户明确给出的链接");
    expect(draft.generatedPrompt).toContain("说明书/用药指南链接：https://example.com/drug-guide。");
    expect(draft.generatedPrompt).toContain("粘贴说明书重点：用法用量：饭后服用。漏服请咨询医生。");
    expect(draft.generatedPrompt).toContain("只根据用户资料和医嘱文本整理提醒");
    expect(draft.generatedPrompt).toContain("不新增药品建议、不改剂量");
  });

  it("uses pasted study material and links before generating SRS questions", () => {
    const pack = getScenarioTaskPack("srs-study-checkin");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        studyType: "背古诗/文言文",
        sourceBook: "用户自己粘贴或链接的材料",
        customMaterial: "《登高》：风急天高猿啸哀，渚清沙白鸟飞回。",
        materialLinks: "https://example.com/poem-list",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("用户资料使用方式");
    expect(draft.generatedPrompt).toContain("自定义材料：《登高》：风急天高猿啸哀，渚清沙白鸟飞回。");
    expect(draft.generatedPrompt).toContain("资料链接：https://example.com/poem-list。");
    expect(draft.generatedPrompt).toContain("先读取用户选择的公开范围和粘贴材料");
    expect(draft.generatedPrompt).toContain("资料不足时明确说明缺口");
    expect(draft.generatedPrompt).toContain("不把公开范围说成自带书库或词库");
  });

  it("keeps only mature one-shot tasks for the featured one-shot row", () => {
    expect(SCENARIO_TASK_PACKS.filter((pack) => pack.runMode === "one-shot").map((pack) => pack.id)).toEqual([
      "weekend-shopping-list",
      "flight-departure-once",
    ]);
  });

  it("builds runnable drafts for the featured rank list and one-shot shelf", () => {
    const now = new Date(2026, 6, 13, 14, 30, 0);
    const rankList = [...SCENARIO_TASK_PACKS].sort((a, b) => {
      const fa = a.featured ? 1 : 0;
      const fb = b.featured ? 1 : 0;
      return fb - fa || b.subscriberCount - a.subscriberCount;
    }).slice(0, 10);
    const oneShotShelf = SCENARIO_TASK_PACKS.filter((pack) => pack.runMode === "one-shot").slice(0, 4);

    expect(rankList).toHaveLength(10);
    expect(oneShotShelf).toHaveLength(2);

    for (const pack of [...rankList, ...oneShotShelf]) {
      const draft = buildScenarioTaskDraft({ pack, values: {}, now, deliver: "qqbot" });
      expect(draft.scenarioId).toBe(pack.id);
      expect(draft.generatedName).toContain(pack.name);
      expect(draft.generatedPrompt).toContain(pack.name);
      expect(draft.generatedPrompt).toContain("自动化工作流");
      expect(draft.generatedDeliver).toBe("qqbot");
      expect(draft.oneShotSchedule).toMatch(/^2026-07-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(draft.recurringSchedule.split(/\s+/)).toHaveLength(5);
      expect(draft.values).toEqual(
        Object.fromEntries(pack.fields.map((field) => [field.key, field.defaultValue])),
      );
    }
  });

  it("keeps every published task square template production-runnable", () => {
    const now = new Date(2026, 6, 14, 10, 0, 0);
    for (const pack of SCENARIO_TASK_PACKS) {
      expect(pack.id).toMatch(/^[a-z0-9-]+$/);
      expect(pack.name.trim()).not.toBe("");
      expect(pack.valueProp.trim()).not.toBe("");
      expect(pack.description.trim()).not.toBe("");
      expect(pack.defaultSchedule.split(/\s+/)).toHaveLength(5);
      expect(pack.fields.length).toBeGreaterThan(0);

      for (const field of pack.fields) {
        expect(field.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
        expect(field.label.trim()).not.toBe("");
        if (field.type === "select" || field.type === "multiselect") {
          expect(field.options?.length).toBeGreaterThan(0);
        }
      }

      const draft = buildScenarioTaskDraft({ pack, values: {}, now, deliver: "weixin" });
      expect(draft.generatedPrompt).not.toMatch(/undefined|null|TODO|草稿|demo/i);
      expect(draft.generatedDeliver).toBe("weixin");
      expect(draft.generatedDeliverLabel).toBe("微信");
      expect(draft.oneShotJobName).toBe(`${draft.generatedName} · 单次执行`);
      const createCommand = buildCreateCommand({
        name: pack.runMode === "one-shot" ? draft.oneShotJobName : draft.generatedName,
        prompt: draft.generatedPrompt,
        schedule: pack.runMode === "one-shot" ? draft.oneShotSchedule : draft.recurringSchedule,
        skills: draft.skillIds,
        deliver: draft.generatedDeliver,
      });
      expect(createCommand).toContain("hermes cron create");
      expect(createCommand).toContain("--deliver 'weixin'");
      for (const skillId of draft.skillIds) {
        expect(createCommand).toContain(`--skill '${skillId}'`);
      }

      if (pack.skillIds?.length) {
        expect(pack.skillSources?.length).toBeGreaterThanOrEqual(pack.skillIds.length);
        for (const skillId of pack.skillIds) {
          const source = pack.skillSources?.find((item) => item.slug === skillId);
          expect(source?.url).toBe(`https://skillhub.cn/skills/${skillId}`);
          expect(source?.provider.trim()).not.toBe("");
        }
      }
    }
  });

  it("asks study check-ins to use the selected source material", () => {
    const pack = getScenarioTaskPack("srs-study-checkin");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        studyType: "背古诗",
        sourceBook: "公开范围：小学常见必背古诗",
        dailyAmount: "新学 3 个 + 复习 8 个",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("学习类型：背古诗。");
    expect(draft.generatedPrompt).toContain("资料来源/范围：公开范围：小学常见必背古诗。");
    expect(draft.generatedPrompt).toContain("不把公开范围说成自带书库或词库");
    expect(draft.generatedPrompt).toContain("实体抽取方式");
  });

  it("publishes learning and global categories without exposing empty sports", () => {
    expect(SCENARIO_CATEGORIES.map((category) => category.id)).not.toContain("sports");
    expect(getScenarioTaskPack("srs-study-checkin").category).toBe("study");
    expect(getScenarioTaskPack("ai-hot-daily").category).toBe("study");
    expect(getScenarioTaskPack("global-holiday-reminder").category).toBe("content");
  });

  it("uses ISO currency dropdown values for both sides of the currency pair", () => {
    const pack = getScenarioTaskPack("country-fx-alert");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        fromCurrency: "TRY",
        toCurrency: "INR",
      },
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedPrompt).toContain("换出币种：TRY。");
    expect(draft.generatedPrompt).toContain("换入币种：INR。");
    expect(draft.generatedPrompt).toContain("ISO 4217");
  });

  it("summarizes user configuration for repeated jobs", () => {
    const pack = getScenarioTaskPack("rent-reminder");
    const values = {
      dueDay: "12",
      rentInfo: "每月 12 号交家里水电，金额看账单，通过微信转账",
      advanceDays: "3",
      includeDueDay: "true",
    };
    const draft = buildScenarioTaskDraft({
      pack,
      values,
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(draft.generatedName).toBe("交租提醒 · 每月 12 号交家里水电，金额看…");
    expect(buildScenarioTaskConfigSummary(pack, values)).toBe(
      "提醒时间：09:00；本期到期日：2026-12-31；租金/账单信息：每月 12 号交家里水电，金额看账单，通过微信转账",
    );
    expect(isScenarioRecurringJobName({ generatedName: pack.name }, draft.generatedName)).toBe(true);
  });

  it("parses one-shot schedules in local datetime format", () => {
    expect(parseOneShotSchedule("2026/07/10 10:30")).toBe("2026-07-10T10:30:00");
    expect(parseOneShotSchedule("2026-07-10T10:30:45")).toBe("2026-07-10T10:30:45");
    expect(parseOneShotSchedule("明天上午")).toBeNull();
  });

  it("keeps selected scan-code channels as the Cron deliver target", () => {
    const pack = getScenarioTaskPack("hydration-standup-reminder");

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

    expect(normalizeScenarioDeliverTarget("feishu")).toBe("feishu");
    expect(normalizeScenarioDeliverTarget("wecom,feishu")).toBe("wecom,feishu");
    expect(formatScenarioDeliverLabel("local")).toBe("网页 / 最近执行");
  });

  it("matches preview runs by job name first, then prompt fallback", () => {
    const pack = getScenarioTaskPack("weather-warning-alert");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {
        region: "深圳",
        warningTypes: "暴雨|交通",
        alertLevel: "黄色及以上提醒，橙色/红色加急",
      },
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

  it("matches legacy preview job names while the new name is rolling out", () => {
    const pack = getScenarioTaskPack("weather-warning-alert");
    const draft = buildScenarioTaskDraft({
      pack,
      values: {},
      now: new Date(2026, 6, 2, 9, 0, 0),
    });

    expect(findScenarioPreviewRun(draft, [
      makeRun({
        id: "legacy-name-run",
        job_name: `试跑 - ${draft.generatedName}`,
        run_at: "2026-07-02T01:04:00.000Z",
      }),
    ], Date.parse("2026-07-02T01:00:00.000Z"))?.id).toBe("legacy-name-run");
  });

  it("ignores stale recent runs from before preview creation", () => {
    const pack = getScenarioTaskPack("hydration-standup-reminder");
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
