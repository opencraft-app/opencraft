import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/t", () => ({
  t: (value: string) => value,
}));

import { MODEL_PROVIDER_LIST } from "../model-providers";

describe("MODEL_PROVIDER_LIST", () => {
  it("使用最新的 Hy Token Plan 模型介绍文案", () => {
    const provider = MODEL_PROVIDER_LIST.find((item) => item.value === "tencent_hy_token_plan");

    expect(provider?.description).toBe(
      "基于腾讯2026年最新推出的混元模型打造：集成 Hy3 模型，面向 Agent 工作负载设计，适配 Coding Agent、文档自动化、多步工具调用等工作流。",
    );
  });
});
