import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 模拟国际站非简体中文语言（en-US）：仅运行时语言决定 prompt 中英文，
// 与站点区域无关。i18n.language 是字典 key（en-US）。
vi.mock("@/i18n", () => ({
  default: { language: "en-US" },
}));

import {
  WORKBENCH_TEMPLATE_PROMPTS_EN,
  isChinesePromptLocale,
  readPendingWorkbenchPrompt,
  savePendingWorkbenchPrompt,
  withSharedTechStack,
} from "../workbench-prompt-templates";

const HAS_CJK = /[\u4e00-\u9fff]/;

describe("workbench-prompt-templates（非简体中文语言）", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("isChinesePromptLocale 仅 zh-CN 判定中文，其余语言（含繁体）判定英文", () => {
    expect(isChinesePromptLocale("zh-CN")).toBe(true);
    expect(isChinesePromptLocale("en-US")).toBe(false);
    expect(isChinesePromptLocale("zh-Hant")).toBe(false);
    expect(isChinesePromptLocale("id-ID")).toBe(false);
    expect(isChinesePromptLocale("ja-JP")).toBe(false);
  });

  it("英文模板 prompt 为英文且不含中文", () => {
    for (const id of ["tool", "dashboard", "campaign", "profile", "blank"] as const) {
      expect(WORKBENCH_TEMPLATE_PROMPTS_EN[id].trim().length).toBeGreaterThan(0);
      expect(WORKBENCH_TEMPLATE_PROMPTS_EN[id]).not.toMatch(HAS_CJK);
    }
  });

  it("英文模板 prompt 使用英文场景关键词", () => {
    expect(WORKBENCH_TEMPLATE_PROMPTS_EN.tool).toContain("clean utility dashboard");
    expect(WORKBENCH_TEMPLATE_PROMPTS_EN.dashboard).toContain("data dashboard");
    expect(WORKBENCH_TEMPLATE_PROMPTS_EN.campaign).toContain("campaign landing");
    expect(WORKBENCH_TEMPLATE_PROMPTS_EN.profile).toContain("personal showcase");
    expect(WORKBENCH_TEMPLATE_PROMPTS_EN.blank).toContain("proactively ask me");
  });

  it("英文模板文案本身不含技术栈约束（约束在发送时统一追加）", () => {
    for (const id of ["tool", "dashboard", "campaign", "profile", "blank"] as const) {
      expect(WORKBENCH_TEMPLATE_PROMPTS_EN[id]).not.toContain("shadcn/ui");
      expect(WORKBENCH_TEMPLATE_PROMPTS_EN[id]).not.toContain("localStorage");
    }
  });

  it("非简体中文语言下 save 后 read 回英文 prompt", () => {
    const ok = savePendingWorkbenchPrompt("blank");
    expect(ok).toBe(true);

    const pending = readPendingWorkbenchPrompt();
    expect(pending).not.toBeNull();
    expect(pending?.prompt).toContain("proactively ask me");
    expect(pending?.prompt).not.toMatch(HAS_CJK);
  });

  it("非简体中文语言下 withSharedTechStack 追加英文技术栈", () => {
    const result = withSharedTechStack(WORKBENCH_TEMPLATE_PROMPTS_EN.tool);
    expect(result).toContain("Tech stack: React + TypeScript + Tailwind CSS");
    expect(result).toContain("shadcn/ui");
    expect(result).toContain("localStorage");
    expect(result).toContain("website-builder Skill");
    expect(result).not.toMatch(HAS_CJK);
  });
});
