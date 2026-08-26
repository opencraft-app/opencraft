import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WORKBENCH_TEMPLATE_PROMPTS,
  clearPendingWorkbenchPrompt,
  readPendingWorkbenchPrompt,
  savePendingWorkbenchPrompt,
  withSharedTechStack,
} from "../workbench-prompt-templates";

const STORAGE_KEY = "lightvela-pending-workbench-prompt-v1";

describe("workbench-prompt-templates", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("为所有模板都提供了非空提示词", () => {
    for (const id of ["tool", "dashboard", "campaign", "profile", "blank"] as const) {
      expect(WORKBENCH_TEMPLATE_PROMPTS[id].trim().length).toBeGreaterThan(0);
    }
  });

  it("模板文案本身不含技术栈约束（约束在发送时统一追加）", () => {
    for (const id of ["tool", "dashboard", "campaign", "profile", "blank"] as const) {
      expect(WORKBENCH_TEMPLATE_PROMPTS[id]).not.toContain("shadcn/ui");
      expect(WORKBENCH_TEMPLATE_PROMPTS[id]).not.toContain("localStorage");
    }
  });

  it("blank 模板引导 Agent 主动发问，用于「创建我的工作台」空白入口", () => {
    expect(WORKBENCH_TEMPLATE_PROMPTS.blank).toContain("请先主动问我");
  });

  it("withSharedTechStack 在非空 prompt 末尾追加技术栈约束", () => {
    const result = withSharedTechStack(WORKBENCH_TEMPLATE_PROMPTS.tool);
    // 原始场景描述保留在前
    expect(result.startsWith(WORKBENCH_TEMPLATE_PROMPTS.tool)).toBe(true);
    // 关键约束被追加
    expect(result).toContain("React + TypeScript + Tailwind CSS");
    expect(result).toContain("shadcn/ui");
    expect(result).toContain("lucide-react");
    expect(result).toContain("Recharts");
    expect(result).toContain("localStorage");
    expect(result).toContain("开始前请先问我");
  });

  it("withSharedTechStack 对空白 prompt 原样返回、不追加约束", () => {
    expect(withSharedTechStack("")).toBe("");
    expect(withSharedTechStack("   ")).toBe("   ");
  });

  it("save 后可 read 回同一模板的提示词", () => {
    const ok = savePendingWorkbenchPrompt("dashboard");
    expect(ok).toBe(true);

    const pending = readPendingWorkbenchPrompt();
    expect(pending).not.toBeNull();
    expect(pending?.templateId).toBe("dashboard");
    expect(pending?.prompt).toBe(WORKBENCH_TEMPLATE_PROMPTS.dashboard);
  });

  it("「创建我的工作台」入口 save(blank) 后可 read 回 blank 引导语", () => {
    const ok = savePendingWorkbenchPrompt("blank");
    expect(ok).toBe(true);

    const pending = readPendingWorkbenchPrompt();
    expect(pending?.templateId).toBe("blank");
    expect(pending?.prompt).toBe(WORKBENCH_TEMPLATE_PROMPTS.blank);
  });

  it("clear 后 read 返回 null", () => {
    savePendingWorkbenchPrompt("tool");
    clearPendingWorkbenchPrompt();
    expect(readPendingWorkbenchPrompt()).toBeNull();
  });

  it("超过 TTL 的 pending 会被判为过期并清除", () => {
    const past = new Date("2026-01-01T00:00:00.000Z");
    savePendingWorkbenchPrompt("campaign", past);

    // 超过 10 分钟 TTL
    const later = new Date(past.getTime() + 11 * 60 * 1000);
    expect(readPendingWorkbenchPrompt(later)).toBeNull();
    // 过期读取应顺带清除脏数据
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("TTL 窗口内的 pending 仍有效", () => {
    const created = new Date("2026-01-01T00:00:00.000Z");
    savePendingWorkbenchPrompt("profile", created);

    const within = new Date(created.getTime() + 5 * 60 * 1000);
    expect(readPendingWorkbenchPrompt(within)?.templateId).toBe("profile");
  });

  it("损坏的 JSON 会被清除并返回 null", () => {
    window.sessionStorage.setItem(STORAGE_KEY, "{not-json");
    expect(readPendingWorkbenchPrompt()).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("未知 templateId 的脏数据会被拒绝", () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ templateId: "unknown", prompt: "x", createdAt: new Date().toISOString() }),
    );
    expect(readPendingWorkbenchPrompt()).toBeNull();
  });
});
