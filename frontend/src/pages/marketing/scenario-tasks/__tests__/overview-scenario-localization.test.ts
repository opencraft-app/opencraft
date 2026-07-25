import { describe, expect, it } from "vitest";

import {
  formatScenarioQuickPrompt,
  getOverviewScenarioTaskPacks,
  OVERVIEW_SCENARIO_TASK_PACKS,
} from "../scenario-packs";

const HAN_CHARACTER_PATTERN = /[\u3400-\u9fff]/;

describe("getOverviewScenarioTaskPacks", () => {
  it("keeps the six overview automations in Chinese for both Chinese locales", () => {
    for (const locale of ["zh-CN", "zh-SG"] as const) {
      const packs = getOverviewScenarioTaskPacks(locale);

      expect(packs).toHaveLength(6);
      expect(packs.map((pack) => pack.name)).toEqual([
        "喝水与吃药提醒",
        "交租提醒",
        "汇率到价提醒",
        "卡路里与健身记录",
        "节假日与天气",
        "股票信息速递",
      ]);
    }
  });

  it("localizes every visible English card and default task request without changing automation behavior", () => {
    const packs = getOverviewScenarioTaskPacks("en-US");

    expect(packs.map((pack) => pack.name)).toEqual([
      "Water & medication reminders",
      "Rent reminder",
      "Exchange-rate alert",
      "Calorie & fitness log",
      "Holidays & weather",
      "Stock update digest",
    ]);

    packs.forEach((pack, index) => {
      const original = OVERVIEW_SCENARIO_TASK_PACKS[index];
      expect(original).toBeDefined();
      expect(pack.id).toBe(original?.id);
      expect(pack.defaultSchedule).toBe(original?.defaultSchedule);
      expect(pack.promptBuilder).toBe(original?.promptBuilder);
      expect(HAN_CHARACTER_PATTERN.test(pack.name)).toBe(false);
      expect(HAN_CHARACTER_PATTERN.test(pack.valueProp)).toBe(false);
      expect(HAN_CHARACTER_PATTERN.test(pack.description)).toBe(false);
      const defaultValues = Object.fromEntries(
        pack.fields.map((field) => [field.key, field.defaultValue]),
      );
      expect(HAN_CHARACTER_PATTERN.test(formatScenarioQuickPrompt(pack, defaultValues))).toBe(false);
    });
  });

  it("includes an editable reminder time in every Chinese and English overview task request", () => {
    for (const locale of ["zh-CN", "zh-SG", "en-US"] as const) {
      for (const pack of getOverviewScenarioTaskPacks(locale)) {
        const defaultValues = Object.fromEntries(
          pack.fields.map((field) => [field.key, field.defaultValue]),
        );

        expect(formatScenarioQuickPrompt(pack, defaultValues), pack.name).toMatch(
          /\b\d{1,2}:\d{2}\b/,
        );
      }
    }
  });
});
