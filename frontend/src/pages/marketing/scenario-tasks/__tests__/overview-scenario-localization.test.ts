import { describe, expect, it } from "vitest";

import {
  formatScenarioQuickPrompt,
  getOverviewScenarioTaskPacks,
  OVERVIEW_SCENARIO_TASK_PACKS,
} from "../scenario-packs";

const HAN_CHARACTER_PATTERN = /[\u3400-\u9fff]/;

function spanishVisibleStrings(pack: (typeof OVERVIEW_SCENARIO_TASK_PACKS)[number]): string[] {
  const topLevel = [
    pack.name,
    pack.valueProp,
    pack.description,
    pack.quickPrompt,
    pack.defaultFrequencyLabel,
    pack.durationLabel,
    pack.defaultDeliverLabel,
    pack.requiredInfoLabel,
    ...(pack.usageGuide ?? []),
    ...(pack.safetyNote ? [pack.safetyNote] : []),
  ];
  const quickPromptCopy = (pack.quickPromptTemplate ?? []).flatMap((part) => {
    if (part.type === "text") return [part.text];
    return [part.trueLabel, part.falseLabel].filter((value): value is string => Boolean(value));
  });
  const fieldCopy = pack.fields.flatMap((field) => {
    const selectedOption = field.options?.find((option) => option.value === field.defaultValue);
    return [
      field.label,
      field.placeholder,
      field.helpText,
      selectedOption?.label ?? field.defaultValue,
      ...(field.options?.map((option) => option.label) ?? []),
    ].filter((value): value is string => Boolean(value));
  });
  return [...topLevel, ...quickPromptCopy, ...fieldCopy];
}

describe("getOverviewScenarioTaskPacks", () => {
  it("keeps Chinese and English overview pack ids aligned by index", () => {
    const zhPacks = getOverviewScenarioTaskPacks("zh-CN");
    const enPacks = getOverviewScenarioTaskPacks("en-US");

    expect(enPacks).toHaveLength(zhPacks.length);
    expect(enPacks.map((pack) => pack.id)).toEqual(zhPacks.map((pack) => pack.id));
  });

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
      if (original?.safetyNote) {
        expect(pack.safetyNote).toBeTruthy();
        expect(HAN_CHARACTER_PATTERN.test(pack.safetyNote ?? ""), pack.name).toBe(false);
      }
      const defaultValues = Object.fromEntries(
        pack.fields.map((field) => [field.key, field.defaultValue]),
      );
      expect(HAN_CHARACTER_PATTERN.test(formatScenarioQuickPrompt(pack, defaultValues))).toBe(false);
    });
  });

  it("localizes every visible Indonesian card and default task request without changing automation behavior", () => {
    const packs = getOverviewScenarioTaskPacks("id-ID");

    expect(packs.map((pack) => pack.name)).toEqual([
      "Pengingat minum air & obat",
      "Pengingat sewa",
      "Pengingat kurs target",
      "Catatan kalori & kebugaran",
      "Hari libur & cuaca",
      "Ringkasan info saham",
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
      const quickPrompt = formatScenarioQuickPrompt(pack, defaultValues);
      expect(HAN_CHARACTER_PATTERN.test(quickPrompt)).toBe(false);
      expect(quickPrompt).not.toMatch(/\b(Remind|Every day|Notes|Follow my|Monitor|Summarize)\b/);
    });
  });

  it("localizes all six Spanish packs, prompts, safety copy, and dates without changing behavior", () => {
    const packs = getOverviewScenarioTaskPacks("es");

    expect(packs.map((pack) => pack.name)).toEqual([
      "Recordatorios de agua y medicación",
      "Recordatorio del alquiler",
      "Alerta de tipo de cambio",
      "Registro de calorías y ejercicio",
      "Festivos y clima",
      "Resumen bursátil",
    ]);

    packs.forEach((pack, index) => {
      const original = OVERVIEW_SCENARIO_TASK_PACKS[index];
      expect(original).toBeDefined();
      expect(pack.id).toBe(original?.id);
      expect(pack.defaultSchedule).toBe(original?.defaultSchedule);
      expect(pack.promptBuilder).toBe(original?.promptBuilder);
      expect(pack.quickPromptLocale).toBe("es");
      expect(HAN_CHARACTER_PATTERN.test(pack.name)).toBe(false);
      expect(HAN_CHARACTER_PATTERN.test(pack.valueProp)).toBe(false);
      expect(HAN_CHARACTER_PATTERN.test(pack.description)).toBe(false);

      const defaultValues = Object.fromEntries(
        pack.fields.map((field) => [field.key, field.defaultValue]),
      );
      const quickPrompt = formatScenarioQuickPrompt(pack, defaultValues);
      expect(HAN_CHARACTER_PATTERN.test(quickPrompt), pack.name).toBe(false);
    });

    const rentPack = packs.find((pack) => pack.id === "rent-reminder");
    expect(rentPack).toBeDefined();
    const rentValues = Object.fromEntries(
      rentPack!.fields.map((field) => [field.key, field.defaultValue]),
    );
    rentValues.dueDate = "2026-09-01";
    const rentPrompt = formatScenarioQuickPrompt(rentPack!, rentValues);
    expect(rentPrompt).toContain("2026-09-01");
    expect(rentPrompt).not.toMatch(/[年月日]/);
  });

  it("localizes every user-visible Spanish field string while preserving automation data", () => {
    const packs = getOverviewScenarioTaskPacks("es");

    packs.forEach((pack, index) => {
      const original = OVERVIEW_SCENARIO_TASK_PACKS[index];
      expect(original).toBeDefined();
      expect(pack.id).toBe(original?.id);
      expect(pack.defaultSchedule).toBe(original?.defaultSchedule);
      expect(pack.promptBuilder).toBe(original?.promptBuilder);
      expect(pack.fields.map((field) => field.key)).toEqual(
        original?.fields.map((field) => field.key),
      );
      pack.fields.forEach((field, fieldIndex) => {
        const originalField = original?.fields[fieldIndex];
        expect(field.options?.map((option) => option.value) ?? []).toEqual(
          originalField?.options?.map((option) => option.value) ?? [],
        );
        expect(field.visibleWhen).toEqual(originalField?.visibleWhen);
      });

      const chineseVisibleStrings = spanishVisibleStrings(pack).filter((value) =>
        HAN_CHARACTER_PATTERN.test(value),
      );
      expect(chineseVisibleStrings, `${pack.id} 仍有中文用户可见文案`).toEqual([]);
    });
  });

  it("includes an editable reminder time in every localized overview task request", () => {
    for (const locale of ["zh-CN", "zh-SG", "en-US", "id-ID", "es"] as const) {
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
