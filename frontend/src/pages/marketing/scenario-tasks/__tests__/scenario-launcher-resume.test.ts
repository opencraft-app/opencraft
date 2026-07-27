import { beforeEach, describe, expect, it } from "vitest";

import {
  getScenarioActivationPrerequisite,
  getPendingScenarioSkillResumeState,
  resolvePendingScenarioDeliver,
} from "../ScenarioTaskLauncher";
import {
  clearPendingScenarioInstall,
  readPendingScenarioInstall,
  savePendingScenarioInstall,
} from "../scenario-pending-install";

describe("scenario launcher resume", () => {
  beforeEach(() => {
    clearPendingScenarioInstall();
  });

  it("sends signed-out and unsubscribed users through purchase before resuming", () => {
    expect(getScenarioActivationPrerequisite({
      isLoggedIn: false,
      isSubscribed: false,
      botId: null,
      botsLoading: false,
    })).toBe("subscribe");
    expect(getScenarioActivationPrerequisite({
      isLoggedIn: true,
      isSubscribed: false,
      botId: "bot-1",
      botsLoading: false,
    })).toBe("subscribe");
  });

  it("keeps the task draft while login, purchase, or agent creation completes", () => {
    savePendingScenarioInstall({
      scenarioId: "stock-info-digest",
      values: { stockList: "腾讯控股 00700" },
      userPrompt: "请整理腾讯控股 00700 的股票信息。",
      deliver: "wecom,feishu",
    }, new Date("2026-07-23T10:00:00+08:00"));

    expect(readPendingScenarioInstall(new Date("2026-07-23T10:10:00+08:00"))).toMatchObject({
      scenarioId: "stock-info-digest",
      deliver: "wecom,feishu",
    });
  });

  it("does not block resume when no optional skill was selected", () => {
    expect(getPendingScenarioSkillResumeState(undefined, {
      status: "idle",
      slugs: [],
      error: null,
    })).toBe("ready");
  });

  it("resumes only when every originally selected notification channel is still connected", () => {
    expect(resolvePendingScenarioDeliver("wecom,feishu", new Set(["wecom", "feishu"]))).toBe("wecom,feishu");
    expect(resolvePendingScenarioDeliver("wecom", new Set(["feishu"]))).toBeNull();
    expect(resolvePendingScenarioDeliver("wecom,feishu", new Set(["wecom"]))).toBeNull();
    expect(resolvePendingScenarioDeliver("wecom", null)).toBeNull();
  });
});
