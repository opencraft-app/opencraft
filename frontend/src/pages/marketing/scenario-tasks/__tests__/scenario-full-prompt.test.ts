import { describe, expect, it } from "vitest";

import {
  buildScenarioFullPrompt,
  parseScenarioFullPrompt,
} from "../scenario-full-prompt";
import { getScenarioTaskPack } from "../scenario-packs";

describe("scenario full prompt", () => {
  it("keeps the editable task request and execution rules in one generated prompt", () => {
    const pack = getScenarioTaskPack("stock-info-digest");
    const taskRequest = "请整理腾讯控股 00700 的最新价格、公告和财报变化。";
    const prompt = buildScenarioFullPrompt(pack, taskRequest);

    expect(prompt).toContain(`【任务要求】${taskRequest}`);
    expect(prompt).toContain("【完整任务说明】");
    expect(prompt).toContain("只做公开信息整理和风险提示");
  });

  it("uses typed reminder times for recurring medication tasks", () => {
    const pack = getScenarioTaskPack("medication-once");
    const prompt = buildScenarioFullPrompt(
      pack,
      "请按疗程重复提醒我喝水并按医嘱服药，每天在 08:00、12:30、20:00 提醒。",
    );
    const parsed = parseScenarioFullPrompt(prompt, new Date("2026-07-23T08:00:00+08:00"));

    expect(parsed.issue).toBeNull();
    expect(parsed.runMode).toBe("recurring");
    expect(parsed.dailyTimes).toEqual(["08:00", "12:30", "20:00"]);
  });

  it("recognizes a typed one-shot date and time", () => {
    const pack = getScenarioTaskPack("medication-once");
    const prompt = buildScenarioFullPrompt(
      pack,
      "仅这一次，请在 2026-12-31 20:30 提醒我按医嘱服药。",
    );
    const parsed = parseScenarioFullPrompt(prompt, new Date("2026-07-23T08:00:00+08:00"));

    expect(parsed.issue).toBeNull();
    expect(parsed.runMode).toBe("one-shot");
    expect(parsed.schedule).toBe("2026-12-31T20:30:00");
  });
});
