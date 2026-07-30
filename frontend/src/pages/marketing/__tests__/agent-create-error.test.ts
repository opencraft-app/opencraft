import { describe, expect, it } from "vitest";

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

  it("空错误使用通用创建失败提示", () => {
    expect(getAgentCreateErrorMessage(null)).toBe("创建失败，请稍后重试。");
  });
});
