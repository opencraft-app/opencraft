import { describe, expect, it } from "vitest";

import enUS from "@/i18n/generated/en-US.json";
import idID from "@/i18n/generated/id-ID.json";
import zhToKey from "@/i18n/generated/zh-to-key.json";

const NON_PRODUCT_COPY = new Set([
  "多次使用计划任务或自主定时任务。",
  "定时任务唤醒师",
]);

const SCHEDULED_TASK_COPY = Object.entries(zhToKey).filter(
  ([source]) => source.includes("定时任务") && !NON_PRODUCT_COPY.has(source),
);

describe("Scheduled Tasks product terminology", () => {
  it("uses Scheduled Task terminology in every affected English string", () => {
    expect(SCHEDULED_TASK_COPY.length).toBeGreaterThan(40);

    for (const [source, key] of SCHEDULED_TASK_COPY) {
      const translation = (enUS as Record<string, string>)[key];

      expect(translation, source).toMatch(/scheduled tasks?/i);
      expect(translation, source).not.toMatch(/\bautomations?\b/i);
    }
  });

  it("uses Tugas Terjadwal terminology in every affected Indonesian string", () => {
    expect(SCHEDULED_TASK_COPY.length).toBeGreaterThan(40);

    for (const [source, key] of SCHEDULED_TASK_COPY) {
      const translation = (idID as Record<string, string>)[key];

      expect(translation, source).toMatch(/tugas terjadwal/i);
      expect(translation, source).not.toMatch(/\botomasi\b/i);
    }
  });
});
