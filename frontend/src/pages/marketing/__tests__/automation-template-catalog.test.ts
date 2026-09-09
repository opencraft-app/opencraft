import { describe, expect, it } from "vitest";

import type { HermesAutomationBlueprint } from "@/lib/hermes-cron-client";
import {
  AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH,
  composeAutomationExecutionPrompt,
  HERMES_AUTOMATION_BLUEPRINT_BASELINE,
  HERMES_BLUEPRINT_OVERLAPS,
  enrichLightVelaAutomationTemplates,
  getAutomationVisiblePromptMaxLength,
  mergeAutomationTemplateCatalog,
  splitAutomationExecutionPrompt,
  toAutomationTemplateSchedule,
  type AutomationCatalogTemplate,
} from "../automation-template-catalog";

const lightvelaTemplate: AutomationCatalogTemplate = {
  id: "weekly-review",
  source: "lightvela",
  name: "周五工作复盘",
  description: "复盘本周工作",
  category: "productivity",
  tags: ["weekly"],
  prompt: "复盘本周工作。",
  schedule: { kind: "recurring", period: "weekly", weekday: 5, time: "18:00" },
  scheduleLabel: "每周五 18:00",
  deliver: "local",
  skills: [],
  notificationPolicy: "always",
  previewKind: "review",
};

function blueprint(overrides: Partial<HermesAutomationBlueprint> = {}): HermesAutomationBlueprint {
  return {
    key: "morning-brief",
    title: "Morning briefing",
    description: "Calendar, weather, and urgent items.",
    category: "daily",
    tags: ["daily", "briefing"],
    fields: [],
    scheduleHuman: "daily at 08:00",
    spec: {
      name: "Morning briefing",
      prompt: "Produce a concise morning briefing.",
      schedule: "0 8 * * *",
      deliver: "origin",
      skills: ["google-workspace"],
    },
    ...overrides,
  };
}

describe("automation template catalog", () => {
  it("keeps the official Hermes baseline available when a runtime catalog is unavailable", () => {
    const result = mergeAutomationTemplateCatalog([], [], "zh-CN");

    expect(HERMES_AUTOMATION_BLUEPRINT_BASELINE).toHaveLength(10);
    expect(result.slice(0, 4).map((item) => item.id)).toEqual([
      "morning-brief",
      "price-watch",
      "learn-daily",
      "meal-plan",
    ]);
    expect(result.find((item) => item.id === "important-mail")).toMatchObject({
      source: "hermes",
      notificationPolicy: "only-when-needed",
    });
  });

  it("does not bind the built-in web_search tool as an installed Skill", () => {
    const result = mergeAutomationTemplateCatalog([], [
      blueprint({
        key: "on-this-day",
        spec: {
          name: "On this day",
          prompt: "Share one well-sourced event connected to today's date.",
          schedule: "0 9 * * *",
          deliver: "origin",
          skills: ["web-search"],
        },
      }),
    ], "zh-CN");

    expect(result.find((item) => item.id === "on-this-day")?.skills).toEqual([]);
  });

  it("uses the current official Hermes Skill slugs in the fallback catalog", () => {
    const result = mergeAutomationTemplateCatalog([], [], "zh-CN");
    const skillsById = new Map(result.map((item) => [item.id, item.skills]));

    expect(skillsById.get("morning-brief")).toEqual(["google-workspace"]);
    expect(skillsById.get("important-mail")).toEqual(["email-inbox-triage"]);
    expect(skillsById.get("evening-winddown")).toEqual([]);
    expect(skillsById.get("price-watch")).toEqual(["product-price-monitor"]);
    expect(skillsById.get("competitor-watch")).toEqual(["competitor-news-monitor"]);
    expect(skillsById.get("learn-daily")).toEqual([]);
    expect(skillsById.get("on-this-day")).toEqual([]);
  });

  it("normalizes legacy capability aliases without producing unavailable Skill chips", () => {
    const result = mergeAutomationTemplateCatalog([], [
      blueprint({
        spec: {
          ...blueprint().spec,
          skills: ["weather", "calendar", "web_search", "google-workspace"],
        },
      }),
    ], "zh-CN");

    expect(result.find((item) => item.id === "morning-brief")?.skills).toEqual([
      "google-workspace",
    ]);
  });

  it("maps the supported Hermes cron defaults to the existing form schedule", () => {
    expect(toAutomationTemplateSchedule("0 8 * * *")).toEqual({
      kind: "recurring",
      period: "daily",
      time: "08:00",
    });
    expect(toAutomationTemplateSchedule("*/30 * * * *")).toEqual({
      kind: "interval",
      intervalNum: 30,
      intervalUnit: "m",
    });
    expect(toAutomationTemplateSchedule("0 */6 * * *")).toEqual({
      kind: "interval",
      intervalNum: 6,
      intervalUnit: "h",
    });
  });

  it("keeps LightVela templates, removes overlap, and adds runtime-only blueprints", () => {
    const result = mergeAutomationTemplateCatalog([
      lightvelaTemplate,
    ], [
      blueprint({ key: "weekly-review", title: "Weekly review" }),
      blueprint(),
    ], "zh-CN");

    expect(HERMES_BLUEPRINT_OVERLAPS.has("weekly-review")).toBe(true);
    expect(result.map((item) => item.id)).toEqual([
      "morning-brief",
      "price-watch",
      "learn-daily",
      "meal-plan",
      "weekly-review",
      "important-mail",
      "custom-reminder",
      "evening-winddown",
      "competitor-watch",
      "gratitude-journal",
      "on-this-day",
    ]);
    expect(result[0]).toMatchObject({
      source: "hermes",
      name: "晨间简报",
      description: "每天汇总日历、天气和需要优先处理的事项",
      category: "daily",
      deliver: "origin",
      skills: ["google-workspace"],
    });
    expect(result[0]?.prompt).toContain("晨间简报");
    expect(result[0]?.prompt).toContain("上海");
  });

  it("keeps official English copy on the global site", () => {
    const result = mergeAutomationTemplateCatalog([], [blueprint()], "en-US");

    expect(result[0]).toMatchObject({
      name: "Morning briefing",
      description: "Calendar, weather, and urgent items.",
      scheduleLabel: "daily at 08:00",
    });
  });

  it("uses Traditional Chinese copy for the zh-Hant global route", () => {
    const result = mergeAutomationTemplateCatalog([], [blueprint()], "zh-Hant");

    expect(result[0]).toMatchObject({
      name: "晨間簡報",
      description: "每天彙整日曆、天氣和需要優先處理的事項",
    });
    expect(result[0]?.prompt).toContain("晨間簡報");
    expect(result[0]?.prompt).toContain("上海");
  });

  it("puts runnable preset values directly in every Chinese Blueprint task description", () => {
    const result = mergeAutomationTemplateCatalog([], [], "zh-CN");
    const promptById = new Map(result.map((item) => [item.id, item.prompt]));

    expect(promptById.get("price-watch")).toContain("AirPods Pro");
    expect(promptById.get("price-watch")).toContain("低于 1500 元或恢复库存");
    expect(promptById.get("learn-daily")).toContain("AI Agent");
    expect(promptById.get("meal-plan")).toContain("2 人");
    expect(promptById.get("meal-plan")).toContain("清淡、少油、不吃辣");
    expect(promptById.get("meal-plan")).toContain("30 分钟内");
    for (const prompt of promptById.values()) {
      expect(prompt).not.toContain("请填写");
      expect(prompt).not.toContain("【可选】");
      expect(prompt).not.toContain("[SILENT]");
      expect(prompt).not.toContain("以上预设可直接修改");
      expect(prompt.length).toBeLessThanOrEqual(90);
    }
  });

  it("keeps Hermes execution rules separate from concise localized prompts", () => {
    const result = mergeAutomationTemplateCatalog([], [], "zh-CN");
    const templateById = new Map(result.map((item) => [item.id, item]));

    expect(templateById.get("morning-brief")?.executionRules).toContain("connected sources");
    expect(templateById.get("important-mail")?.executionRules).toContain("[SILENT]");
    expect(templateById.get("price-watch")?.executionRules).toContain("first run");
    expect(templateById.get("price-watch")?.executionRules).toContain("deduplicate");
    expect(templateById.get("price-watch")?.executionRules).toContain("[SILENT]");
    expect(templateById.get("competitor-watch")?.executionRules).toContain("source links");
    expect(templateById.get("competitor-watch")?.executionRules).toContain("[SILENT]");
    expect(templateById.get("learn-daily")?.executionRules).toContain("earlier lessons");
    expect(templateById.get("meal-plan")?.executionRules).toContain("grocery list");
  });

  it("preserves the selected Agent runtime Prompt as an internal execution rule", () => {
    const result = mergeAutomationTemplateCatalog([], [blueprint({
      spec: {
        ...blueprint().spec,
        prompt: "RUNTIME_BLUEPRINT_RULE_V9",
      },
    })], "zh-CN");

    expect(result[0]?.prompt).not.toContain("RUNTIME_BLUEPRINT_RULE_V9");
    expect(result[0]?.executionRules).toContain("RUNTIME_BLUEPRINT_RULE_V9");
    expect(result[0]?.executionRules).toContain("connected sources");
  });

  it("keeps Traditional Chinese task descriptions short and free of technical rules", () => {
    const result = mergeAutomationTemplateCatalog([], [], "zh-Hant");
    const promptById = new Map(result.map((item) => [item.id, item.prompt]));

    expect(promptById.get("price-watch")).toContain("AirPods Pro");
    expect(promptById.get("price-watch")).not.toContain("[SILENT]");
    expect(promptById.get("competitor-watch")).not.toContain("不要重複");
    for (const prompt of promptById.values()) expect(prompt.length).toBeLessThanOrEqual(90);
  });

  it("round-trips hidden execution rules without exposing them in the editable prompt", () => {
    const executionPrompt = composeAutomationExecutionPrompt(
      "监控 AirPods Pro，低于 1500 元时提醒。",
      "Deduplicate alerts. If nothing changed, return [SILENT].",
    );

    expect(executionPrompt).toContain("[SILENT]");
    expect(splitAutomationExecutionPrompt(executionPrompt)).toEqual({
      visiblePrompt: "监控 AirPods Pro，低于 1500 元时提醒。",
      executionRules: "Deduplicate alerts. If nothing changed, return [SILENT].",
    });
  });

  it("does not hide a manually written lookalike rule block", () => {
    const manualPrompt = "保留完整正文。\n\n<lightvela_internal_rules>\n这也是正文。\n</lightvela_internal_rules>";

    expect(splitAutomationExecutionPrompt(manualPrompt)).toEqual({ visiblePrompt: manualPrompt });
  });

  it("reserves room for internal rules inside the 1000-character execution Prompt limit", () => {
    const executionRules = "Deduplicate alerts. If nothing changed, return exactly [SILENT].";
    const visibleLimit = getAutomationVisiblePromptMaxLength(executionRules);
    const executionPrompt = composeAutomationExecutionPrompt("x".repeat(visibleLimit), executionRules);

    expect(visibleLimit).toBeLessThan(1000);
    expect(executionPrompt.length).toBeLessThanOrEqual(1000);
  });

  it("does not promise visible Prompt space when internal rules already exceed the limit", () => {
    const executionRules = "x".repeat(AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH);

    expect(getAutomationVisiblePromptMaxLength(executionRules)).toBe(0);
  });

  it("falls back to curated rules when a runtime Blueprint Prompt would exceed the limit", () => {
    const result = mergeAutomationTemplateCatalog([], [
      blueprint({
        key: "price-watch",
        spec: {
          name: "Price watch",
          prompt: "runtime ".repeat(200),
          schedule: "0 */6 * * *",
          deliver: "origin",
          skills: ["web-search"],
        },
      }),
    ], "zh-CN");
    const template = result.find((item) => item.id === "price-watch");

    expect(template?.executionRules).not.toContain("runtime runtime");
    expect(composeAutomationExecutionPrompt(template?.prompt ?? "", template?.executionRules).length)
      .toBeLessThanOrEqual(AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH);
  });

  it("caps a runtime-only Blueprint Prompt at the Hermes execution limit", () => {
    const result = mergeAutomationTemplateCatalog([], [
      blueprint({
        key: "future-runtime-blueprint",
        title: "Future runtime blueprint",
        spec: {
          name: "Future runtime blueprint",
          prompt: "x".repeat(AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH + 200),
          schedule: "0 9 * * *",
          deliver: "origin",
          skills: [],
        },
      }),
    ], "en-US");
    const template = result.find((item) => item.id === "future-runtime-blueprint");

    expect(template?.prompt).toHaveLength(AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH);
    expect(composeAutomationExecutionPrompt(template?.prompt ?? "", template?.executionRules).length)
      .toBeLessThanOrEqual(AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH);
  });

  it.each([
    ["es", "Cada semana · 18:00"],
    ["id-ID", "Setiap minggu · 18:00"],
    ["ja-JP", "毎週 · 18:00"],
    ["ko-KR", "매주 · 18:00"],
  ])("localizes existing LightVela schedule labels for %s", (locale, expectedLabel) => {
    const result = enrichLightVelaAutomationTemplates([lightvelaTemplate], locale);

    expect(result[0]?.scheduleLabel).toBe(expectedLabel);
  });

  it("marks condition-based monitors as quiet and skips unsupported schedules", () => {
    const result = mergeAutomationTemplateCatalog([], [
      blueprint({
        key: "important-mail",
        title: "Important-mail monitor",
        spec: {
          name: "Important-mail monitor",
          prompt: "Check important mail.",
          schedule: "*/30 * * * *",
          deliver: "origin",
          skills: ["email-inbox-triage"],
        },
      }),
      blueprint({ key: "unsupported", spec: { ...blueprint().spec, schedule: "@reboot" } }),
    ], "en-US");

    expect(result).toHaveLength(10);
    expect(result.find((item) => item.id === "important-mail")?.notificationPolicy).toBe("only-when-needed");
    expect(result.some((item) => item.id === "unsupported")).toBe(false);
  });
});
