/**
 * 配置进度快照 + 续跑
 *
 * 覆盖「写配置写到一半刷新页面」这条路径：快照能存能读、过期/损坏不会把
 * 创建流程搞崩、续跑真的跳过已完成的步骤（尤其是不能重跑的 cron）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SetupStep } from "@/pages/marketing/agent-buddy-setup";
import {
  buildSetupPlanSignature,
  buildSetupStepKey,
  clearBuddySetupSnapshot,
  collectCompletedKeys,
  hasUnfinishedBuddySetup,
  loadBuddySetupSnapshot,
  saveBuddySetupSnapshot,
} from "@/pages/marketing/agent-buddy-setup-progress";
import { runBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup-runner";

const step = (kind: SetupStep["kind"], command: string, required = false): SetupStep => ({
  kind,
  label: `run ${command}`,
  command,
  required,
  timeoutMs: 1000,
});

const PLAN: SetupStep[] = [
  step("soul", "write soul", true),
  step("profile-meta", "write meta"),
  step("skill", "install skill"),
  step("cron", "hermes cron create daily"),
  step("gateway", "restart gateway"),
];

const baseSnapshot = {
  botId: "bot-1",
  profileId: "profile-1",
  profile: { name: "小助手", description: "帮我处理日常" },
  avatar: { shapeId: "circle", color: "#fff" },
  templateId: "parenting-advisor",
  preserveSoul: false,
  planSignature: buildSetupPlanSignature(PLAN),
  completedKeys: [] as string[],
};

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("快照存取", () => {
  it("存得进也读得出", () => {
    saveBuddySetupSnapshot({ ...baseSnapshot, completedKeys: ["0:soul"] });
    const loaded = loadBuddySetupSnapshot("bot-1");
    expect(loaded?.botId).toBe("bot-1");
    expect(loaded?.completedKeys).toEqual(["0:soul"]);
    expect(loaded?.profile.name).toBe("小助手");
  });

  it("没有快照时返回 null", () => {
    expect(loadBuddySetupSnapshot("bot-1")).toBeNull();
  });

  it("内容被改坏时当作没有，而不是抛错", () => {
    window.sessionStorage.setItem("lv-buddy-setup-progress:bot-1", "{ 这不是 json");
    expect(loadBuddySetupSnapshot("bot-1")).toBeNull();
  });

  it("缺字段的快照不认", () => {
    window.sessionStorage.setItem("lv-buddy-setup-progress:bot-1", JSON.stringify({ botId: "x" }));
    expect(loadBuddySetupSnapshot("bot-1")).toBeNull();
  });

  it("超过有效期就丢弃 —— 隔夜回来不该突然续跑", () => {
    saveBuddySetupSnapshot(baseSnapshot);
    // 31 分钟后
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60 * 1000);
    expect(loadBuddySetupSnapshot("bot-1")).toBeNull();
    vi.restoreAllMocks();
  });

  it("clear 之后读不到", () => {
    saveBuddySetupSnapshot(baseSnapshot);
    clearBuddySetupSnapshot("bot-1");
    expect(loadBuddySetupSnapshot("bot-1")).toBeNull();
  });
});

describe("步骤键与计划指纹", () => {
  it("键用 index + kind，不含 label —— label 会随界面语言变", () => {
    const zh = { ...step("skill", "install"), label: "正在安装技能" };
    const en = { ...step("skill", "install"), label: "Installing skill" };
    expect(buildSetupStepKey(zh, 2)).toBe(buildSetupStepKey(en, 2));
  });

  it("指纹不含 command —— SOUL 命令带时间戳，含它会让快照永远失配", () => {
    const a = [step("soul", "write soul 2026-01-01")];
    const b = [step("soul", "write soul 2026-09-21")];
    expect(buildSetupPlanSignature(a)).toBe(buildSetupPlanSignature(b));
  });

  it("步骤数或类型变了，指纹就不同", () => {
    expect(buildSetupPlanSignature(PLAN)).not.toBe(buildSetupPlanSignature(PLAN.slice(0, 3)));
  });

  it("collectCompletedKeys 只收 done，failed 留给下次重试", () => {
    const keys = collectCompletedKeys([
      { step: PLAN[0]!, status: "done" },
      { step: PLAN[1]!, status: "failed", error: "boom" },
      { step: PLAN[2]!, status: "pending" },
    ]);
    expect(keys).toEqual(["0:soul"]);
  });
});

describe("hasUnfinishedBuddySetup", () => {
  it("没有快照时为 false", () => {
    expect(hasUnfinishedBuddySetup("bot-1")).toBe(false);
  });

  it("快照属于这个 bot 时为 true", () => {
    saveBuddySetupSnapshot({ ...baseSnapshot, completedKeys: ["0:soul"] });
    expect(hasUnfinishedBuddySetup("bot-1")).toBe(true);
  });

  it("快照属于别的 bot 时为 false —— 不能把别人的半截进度算到当前 bot 头上", () => {
    saveBuddySetupSnapshot({ ...baseSnapshot, botId: "bot-2", completedKeys: ["0:soul"] });
    expect(hasUnfinishedBuddySetup("bot-1")).toBe(false);
  });
});

describe("续跑：runBuddySetupPlan 的 completedKeys", () => {
  it("跳过已完成的步骤，只执行剩下的", async () => {
    const executed: string[] = [];
    const exec = vi.fn(async (_botId: string, command: string) => {
      executed.push(command);
      return { status: "succeeded", exitCode: 0, output: "" };
    });

    const result = await runBuddySetupPlan({
      botId: "bot-1",
      steps: PLAN,
      exec,
      // 前 4 步已完成（含 cron），只剩网关
      completedKeys: new Set(["0:soul", "1:profile-meta", "2:skill", "3:cron"]),
    });

    expect(executed).toEqual(["restart gateway"]);
    expect(result.states.map((s) => s.status)).toEqual([
      "done", "done", "done", "done", "done",
    ]);
  });

  it("cron 已完成时绝不重跑 —— hermes cron create 会再建一条同名任务", async () => {
    const executed: string[] = [];
    const exec = vi.fn(async (_botId: string, command: string) => {
      executed.push(command);
      return { status: "succeeded", exitCode: 0, output: "" };
    });

    await runBuddySetupPlan({
      botId: "bot-1",
      steps: PLAN,
      exec,
      completedKeys: new Set(["3:cron"]),
    });

    expect(executed).not.toContain("hermes cron create daily");
    // 其余步骤照常跑
    expect(executed).toContain("write soul");
    expect(executed).toContain("restart gateway");
  });

  it("首次 emit 就带上已完成状态，UI 不会先闪一遍全 pending", async () => {
    const snapshots: string[][] = [];
    await runBuddySetupPlan({
      botId: "bot-1",
      steps: PLAN,
      exec: async () => ({ status: "succeeded", exitCode: 0, output: "" }),
      onProgress: (states) => { snapshots.push(states.map((s) => s.status)); },
      completedKeys: new Set(["0:soul", "1:profile-meta"]),
    });
    expect(snapshots[0]).toEqual(["done", "done", "pending", "pending", "pending"]);
  });

  it("不传 completedKeys 时行为不变，所有步骤都跑", async () => {
    const executed: string[] = [];
    await runBuddySetupPlan({
      botId: "bot-1",
      steps: PLAN,
      exec: async (_botId, command) => {
        executed.push(command);
        return { status: "succeeded", exitCode: 0, output: "" };
      },
    });
    expect(executed).toHaveLength(PLAN.length);
  });

  it("续跑时 required 步骤已完成，不会因为跳过它而误判中止", async () => {
    const result = await runBuddySetupPlan({
      botId: "bot-1",
      steps: PLAN,
      exec: async () => ({ status: "succeeded", exitCode: 0, output: "" }),
      // soul 是 required，标记为已完成
      completedKeys: new Set(["0:soul"]),
    });
    expect(result.failures).toHaveLength(0);
  });
});


describe("recovery boundaries", () => {
  it("isolates snapshots and clearing by Bot", () => {
    saveBuddySetupSnapshot(baseSnapshot);
    saveBuddySetupSnapshot({ ...baseSnapshot, botId: "bot-2" });
    clearBuddySetupSnapshot("bot-1");
    expect(loadBuddySetupSnapshot("bot-1")).toBeNull();
    expect(loadBuddySetupSnapshot("bot-2")?.botId).toBe("bot-2");
    expect(hasUnfinishedBuddySetup()).toBe(false);
  });

  it.each([
    { profile: null }, { avatar: {} }, { completedKeys: [null] }, { preserveSoul: undefined },
  ])("rejects corrupt nested data %j", (invalid) => {
    window.sessionStorage.setItem("lv-buddy-setup-progress:bot-1", JSON.stringify({
      ...baseSnapshot, updatedAt: Date.now(), ...invalid,
    }));
    expect(loadBuddySetupSnapshot("bot-1")).toBeNull();
  });

  it("invalidates changed commands with the same step count and kinds", () => {
    expect(buildSetupPlanSignature([step("skill", "install old")]))
      .not.toBe(buildSetupPlanSignature([step("skill", "install new")]));
  });

  it("continues without throwing when session storage is unavailable", () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disabled"); });
    expect(() => saveBuddySetupSnapshot(baseSnapshot)).not.toThrow();
    storage.mockRestore();
  });
});
