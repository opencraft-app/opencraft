import { describe, expect, it } from "vitest";

import {
  findCompletedCreatingBot,
  getOpenClawCreateLimitMessage,
  resolveOpenClawCreatePermissions,
  type OpenClawCreateAvailabilityBot,
  type OpenClawCreateStatusBot,
} from "../agent-create-availability";

const bot = (status: OpenClawCreateAvailabilityBot["status"]): OpenClawCreateAvailabilityBot => ({ status });
const statusBot = (id: string, status: OpenClawCreateStatusBot["status"]): OpenClawCreateStatusBot => ({ id, status });

describe("resolveOpenClawCreatePermissions", () => {
  it("allows the initial Agent when multi-Bot is disabled", () => {
    expect(resolveOpenClawCreatePermissions(false, null)).toEqual({
      canCreateInitialAgent: true,
      canCreateAdditionalBot: false,
    });
  });

  it("allows an additional Bot only when multi-Bot is enabled", () => {
    expect(resolveOpenClawCreatePermissions(true, null)).toEqual({
      canCreateInitialAgent: true,
      canCreateAdditionalBot: true,
    });
  });

  it("blocks both creation paths at the plan limit", () => {
    expect(resolveOpenClawCreatePermissions(true, "limit reached")).toEqual({
      canCreateInitialAgent: false,
      canCreateAdditionalBot: false,
    });
  });
});

describe("getOpenClawCreateLimitMessage", () => {
  it("allows creation below the plan limit", () => {
    expect(getOpenClawCreateLimitMessage([], 1)).toBeNull();
  });

  it("explains when a provisioning bot already occupies the quota", () => {
    expect(getOpenClawCreateLimitMessage([bot("provisioning")], 1)).toBe("已有智能体正在创建中，请稍后刷新页面查看结果。");
  });

  it("explains when a deleting bot still occupies the quota", () => {
    expect(getOpenClawCreateLimitMessage([bot("deleting")], 1)).toBe("已有智能体正在删除中，请稍后刷新页面后再创建。");
  });

  it("explains the regular plan limit", () => {
    expect(getOpenClawCreateLimitMessage([bot("running")], 1)).toBe("当前套餐最多可创建 1 个智能体，请升级套餐或删除现有智能体后重试。");
  });

  it.each([5, 10])("counts the main Bot toward the %d Bot plan limit", (maxBots) => {
    const bots = Array.from({ length: maxBots }, () => bot("running"));
    expect(getOpenClawCreateLimitMessage(bots, maxBots)).toBe(
      `当前套餐最多可创建 ${maxBots} 个智能体，请升级套餐或删除现有智能体后重试。`,
    );
    expect(getOpenClawCreateLimitMessage(bots.slice(1), maxBots)).toBeNull();
  });
});

describe("findCompletedCreatingBot", () => {
  it("returns the requested bot once it is visible and no longer provisioning", () => {
    const created = statusBot("bot-new", "running");

    expect(findCompletedCreatingBot([statusBot("bot-old", "running"), created], "bot-new")).toBe(created);
  });

  it("keeps waiting while the requested bot is provisioning or deleting", () => {
    expect(findCompletedCreatingBot([statusBot("bot-new", "provisioning")], "bot-new")).toBeNull();
    expect(findCompletedCreatingBot([statusBot("bot-new", "deleting")], "bot-new")).toBeNull();
  });

  it("ignores unrelated or empty requested bot ids", () => {
    expect(findCompletedCreatingBot([statusBot("bot-new", "running")], "bot-other")).toBeNull();
    expect(findCompletedCreatingBot([statusBot("bot-new", "running")], "")).toBeNull();
  });
});
