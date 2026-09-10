import { describe, expect, it } from "vitest";

import zhToKey from "../../../i18n/generated/zh-to-key.json";
import { getAgentCreateErrorMessage } from "../agent-create-error";

describe("getAgentCreateErrorMessage", () => {
  it.each([
    ["SANDBOX_SERVICE_ERROR", "sandbox service error（SANDBOX_SERVICE_ERROR）"],
    ["SANDBOX_STATUS_CONFLICT", "sandbox status conflict（SANDBOX_STATUS_CONFLICT）"],
    [undefined, "all candidate templates failed: no capacity"],
  ])("将沙箱容量类错误弱化为暂时售罄：%s", (code, message) => {
    const error = Object.assign(new Error(message), { code });

    expect(getAgentCreateErrorMessage(error)).toBe("当前资源暂时售罄，请稍后再试。");
  });

  it("保留套餐配额已满提示", () => {
    expect(getAgentCreateErrorMessage(new Error("quota exceeded"))).toBe(
      "当前套餐的 Agent 配额已满，请升级套餐或删除现有 Agent 后重试。",
    );
  });

  it("未知错误不隐藏原始可读信息", () => {
    expect(getAgentCreateErrorMessage(new Error("request rejected"))).toBe("request rejected");
  });

  it("将 Profile capability 错误转成升级提示", () => {
    const error = Object.assign(new Error("Hermes profile capability is unavailable"), {
      code: "INSTANCE_BOT_UNSUPPORTED",
    });
    expect(getAgentCreateErrorMessage(error)).toBe("当前实例版本暂不支持多 Bot，请升级 Agent 后重试。");
  });

  it("将 Profile 操作失败转成友好提示并保留问题编号", () => {
    const error = Object.assign(
      new Error(
        "Hermes profile operation failed（INSTANCE_BOT_PROFILE_FAILED, request_id=f489b1da-e4b5-439e-8813-79b10a8dcc94）",
      ),
      { code: "INSTANCE_BOT_PROFILE_FAILED" },
    );

    expect(getAgentCreateErrorMessage(error)).toBe(
      "暂时无法创建 Bot，请稍后重试。问题编号：f489b1da-e4b5-439e-8813-79b10a8dcc94",
    );
  });

  it("Profile 操作失败没有问题编号时使用简短提示", () => {
    const error = Object.assign(new Error("Hermes profile operation failed"), {
      code: "INSTANCE_BOT_PROFILE_FAILED",
    });

    expect(getAgentCreateErrorMessage(error)).toBe("暂时无法创建 Bot，请稍后重试。");
  });

  it("空错误使用通用创建失败提示", () => {
    expect(getAgentCreateErrorMessage(null)).toBe("创建失败，请稍后重试。");
  });

  it("动态翻译的创建失败文案保持在 i18n 字典中", () => {
    const zhToKeyMap = zhToKey as Record<string, string>;

    [
      "当前套餐的 Agent 配额已满，请升级套餐或删除现有 Agent 后重试。",
      "当前资源暂时售罄，请稍后再试。",
      "创建超时，请稍后重试。",
      "网络异常，请检查网络后重试。",
      "当前实例版本暂不支持多 Bot，请升级 Agent 后重试。",
      "暂时无法创建 Bot，请稍后重试。",
      "暂时无法创建 Bot，请稍后重试。问题编号：{requestId}",
      "创建失败，请稍后重试。",
    ].forEach((message) => {
      expect(zhToKeyMap[message]).toEqual(expect.stringMatching(/^k_/));
    });
  });
});
