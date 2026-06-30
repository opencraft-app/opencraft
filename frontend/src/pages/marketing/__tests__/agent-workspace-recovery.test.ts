import { describe, expect, it } from "vitest";

import {
  buildWorkspaceActionDisabledReason,
  describeWorkspaceActionError,
  getWorkspaceTaskPhaseLabel,
  isWorkspaceActionRunning,
  selectCurrentWorkspaceTask,
  type WorkspaceActionKind,
} from "../agent-workspace-recovery";
import type { WorkerActionStatusResult } from "@/repositories/types";

const status = (phase: string, message = "log", time = "2026-06-30T12:00:00Z"): WorkerActionStatusResult => ({
  phase,
  logs: [{ phase, message, time, level: phase === "failed" ? "error" : "info" }],
});

describe("workspace recovery helpers", () => {
  it("treats only completed and failed phases as terminal", () => {
    expect(isWorkspaceActionRunning(status("starting"))).toBe(true);
    expect(isWorkspaceActionRunning(status("wait_tat"))).toBe(true);
    expect(isWorkspaceActionRunning(status("completed"))).toBe(false);
    expect(isWorkspaceActionRunning(status("failed"))).toBe(false);
    expect(isWorkspaceActionRunning(null)).toBe(false);
  });

  it("selects the running task before the latest terminal task", () => {
    expect(selectCurrentWorkspaceTask(status("wait_tat"), status("completed"))?.kind).toBe("export");
    expect(selectCurrentWorkspaceTask(status("completed"), status("wait_tat"))?.kind).toBe("import");
  });

  it("falls back to the most recently updated terminal task", () => {
    const exportStatus = status("completed", "export done", "2026-06-30T12:00:00Z");
    const importStatus = status("failed", "import failed", "2026-06-30T13:00:00Z");

    expect(selectCurrentWorkspaceTask(exportStatus, importStatus)).toMatchObject({
      kind: "import",
      status: importStatus,
    });
  });

  it("uses task-specific phase labels", () => {
    expect(getWorkspaceTaskPhaseLabel("export", "prepare_archive")).toBe("生成备份包");
    expect(getWorkspaceTaskPhaseLabel("import", "prepare_import")).toBe("校验备份包");
    expect(getWorkspaceTaskPhaseLabel("import", "wait_tat")).toBe("恢复工作区");
    expect(getWorkspaceTaskPhaseLabel("export", undefined)).toBe("暂无任务");
  });

  it("turns infrastructure errors into product-facing copy", () => {
    expect(describeWorkspaceActionError("export", "timed out waiting for ins-47r2jcll; last=PENDING")).toEqual({
      message: "导出环境启动超时，Agent 所在云主机仍在准备中。请稍后重试。",
      detail: "timed out waiting for ins-47r2jcll; last=PENDING",
    });
    expect(describeWorkspaceActionError("import", "timed out waiting for TAT agent online on ins-a; last=Offline").message).toBe(
      "远程命令通道暂时不可用，请稍后重试。",
    );
    expect(describeWorkspaceActionError("import", "bad zip member: foo").message).toBe(
      "备份包无法识别或已损坏，请重新选择 Hermes 导出的 zip 文件。",
    );
  });

  it("explains disabled primary actions", () => {
    const running = status("wait_tat");
    const activeKind: WorkspaceActionKind = "export";

    expect(buildWorkspaceActionDisabledReason({ hasActiveBot: false, botRunning: false, hasEmail: true })).toBe("请选择正在运行的 Agent。");
    expect(buildWorkspaceActionDisabledReason({ hasActiveBot: true, botRunning: false, hasEmail: true })).toBe("Agent 运行中后才能使用工作区任务。");
    expect(buildWorkspaceActionDisabledReason({ hasActiveBot: true, botRunning: true, hasEmail: false })).toBe("请先在账号页绑定邮箱。");
    expect(buildWorkspaceActionDisabledReason({ hasActiveBot: true, botRunning: true, hasEmail: true, currentTask: { kind: activeKind, status: running } })).toBe(
      "当前已有工作区备份任务运行中。",
    );
    expect(buildWorkspaceActionDisabledReason({ hasActiveBot: true, botRunning: true, hasEmail: true })).toBeNull();
  });
});
