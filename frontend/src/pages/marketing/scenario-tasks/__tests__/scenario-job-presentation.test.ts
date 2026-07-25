import { describe, expect, it } from "vitest";

import { getScenarioCronJobPresentation } from "../scenario-job-presentation";

describe("scenario job presentation", () => {
  it("localizes legacy Chinese overview scenario jobs in the English automation panel", () => {
    const presentation = getScenarioCronJobPresentation({
      name: "交租提醒",
      prompt: "你正在执行一个 LightVela 场景任务。\n任务名称：交租提醒\n用户任务要求：房租 5000 元",
    }, "en-US");

    expect(presentation.name).toBe("Rent reminder");
    expect(presentation.prompt).toContain("You are running a LightVela automation");
    expect(presentation.prompt).toContain("Task name: Rent reminder");
    expect(presentation.prompt).not.toContain("你正在执行一个 LightVela 场景任务");
    expect(presentation.prompt).not.toContain("任务名称：交租提醒");
  });

  it("keeps Chinese presentation unchanged for Chinese locales", () => {
    const presentation = getScenarioCronJobPresentation({
      name: "交租提醒",
      prompt: "任务名称：交租提醒",
    }, "zh-CN");

    expect(presentation).toEqual({
      name: "交租提醒",
      prompt: "任务名称：交租提醒",
    });
  });
});
