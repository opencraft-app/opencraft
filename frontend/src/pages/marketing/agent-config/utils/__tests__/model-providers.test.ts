import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/t", () => ({
  t: (value: string) => value,
}));

import { MODEL_PROVIDER_LIST } from "../model-providers";

describe("MODEL_PROVIDER_LIST", () => {
  it("将 Hy Token Plan 个人版固定到 hy4-preview", () => {
    const provider = MODEL_PROVIDER_LIST.find((item) => item.value === "tencent_hy_token_plan");

    expect(provider).toMatchObject({
      description:
        "基于腾讯2026年最新推出的混元模型打造：集成 Hy4 Preview 模型，面向 Agent 工作负载设计，适配 Coding Agent、文档自动化、多步工具调用等工作流。",
      models: [{ id: "hy4-preview", name: "hy4-preview" }],
    });
  });
});
