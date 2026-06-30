import type { WorkerActionStatusResult } from "@/repositories/types";

export type WorkspaceActionKind = "export" | "import";

export interface WorkspaceActionTask {
  kind: WorkspaceActionKind;
  status: WorkerActionStatusResult;
}

export interface WorkspaceActionDisabledInput {
  hasActiveBot: boolean;
  botRunning: boolean;
  hasEmail: boolean;
  resetting?: boolean;
  currentTask?: WorkspaceActionTask | null;
}

export interface WorkspaceActionErrorDescription {
  message: string;
  detail?: string;
}

const WORKSPACE_ACTION_TERMINAL_PHASES = new Set(["completed", "failed"]);

export function isWorkspaceActionRunning(status: WorkerActionStatusResult | null | undefined) {
  if (!status) return false;
  return !WORKSPACE_ACTION_TERMINAL_PHASES.has(status.phase);
}

function latestLogTime(status: WorkerActionStatusResult | null | undefined) {
  if (!status?.logs.length) return 0;
  return status.logs.reduce((latest, log) => {
    if (!log.time) return latest;
    const time = new Date(log.time).getTime();
    return Number.isNaN(time) ? latest : Math.max(latest, time);
  }, 0);
}

export function selectCurrentWorkspaceTask(
  exportStatus: WorkerActionStatusResult | null | undefined,
  importStatus: WorkerActionStatusResult | null | undefined,
): WorkspaceActionTask | null {
  if (isWorkspaceActionRunning(exportStatus)) {
    return { kind: "export", status: exportStatus };
  }
  if (isWorkspaceActionRunning(importStatus)) {
    return { kind: "import", status: importStatus };
  }
  if (exportStatus && importStatus) {
    return latestLogTime(importStatus) >= latestLogTime(exportStatus)
      ? { kind: "import", status: importStatus }
      : { kind: "export", status: exportStatus };
  }
  if (exportStatus) return { kind: "export", status: exportStatus };
  if (importStatus) return { kind: "import", status: importStatus };
  return null;
}

export function getWorkspaceTaskPhaseLabel(kind: WorkspaceActionKind, phase?: string) {
  if (!phase) return "暂无任务";
  if (phase === "starting") return "发起中";
  if (phase === "completed") return "已完成";
  if (phase === "failed") return "未完成";
  if (kind === "import") {
    switch (phase) {
      case "locating":
      case "wait_remote_access":
        return "连接 Agent";
      case "prepare_import":
        return "校验备份包";
      case "start_tat":
      case "wait_tat":
        return "恢复 Agent";
      case "finalize_import":
        return "确认恢复结果";
      case "cleanup_import_object":
        return "清理临时文件";
      case "notify_email":
      case "confirm_email_delivery":
        return "发送邮件";
      default:
        return "恢复处理中";
    }
  }
  switch (phase) {
    case "locating":
      return "定位 Agent";
    case "enter_rescue":
    case "wait_rescue":
    case "wait_remote_access":
      return "准备导出环境";
    case "prepare_archive":
    case "start_tat":
    case "wait_tat":
    case "finalize_archive":
      return "生成备份包";
    case "copy_archive":
      return "上传备份包";
    case "notify_email":
    case "confirm_email_delivery":
      return "发送邮件";
    case "cleanup_remote":
    case "exit_rescue":
    case "wait_running":
      return "恢复运行环境";
    default:
      return "备份处理中";
  }
}

export function describeWorkspaceActionError(
  kind: WorkspaceActionKind,
  rawError: string | null | undefined,
): WorkspaceActionErrorDescription {
  const detail = (rawError ?? "").trim();
  if (!detail) {
    return { message: kind === "import" ? "恢复过程中遇到异常，请稍后重试。" : "备份过程中遇到异常，请稍后重试。" };
  }
  if (detail.includes("last=PENDING") || detail.includes("timed out waiting for ins-")) {
    return {
      message: "导出环境启动超时，Agent 所在云主机仍在准备中。请稍后重试。",
      detail,
    };
  }
  if (detail.includes("timed out waiting for TAT agent online")) {
    return {
      message: "远程命令通道暂时不可用，请稍后重试。",
      detail,
    };
  }
  if (detail.includes("hermes_import_zip_required")) {
    return {
      message: "请选择 Hermes 导出的 zip 文件。",
      detail,
    };
  }
  if (detail.includes("uploaded archive is empty") || detail.includes("bad zip member") || detail.includes("Not a valid zip")) {
    return {
      message: "备份包无法识别或已损坏，请重新选择 Hermes 导出的 zip 文件。",
      detail,
    };
  }
  if (detail.includes("missing_user_email")) {
    return {
      message: "请先在账号页绑定邮箱。",
      detail,
    };
  }
  return { message: detail, detail };
}

export function buildWorkspaceActionDisabledReason(input: WorkspaceActionDisabledInput) {
  if (!input.hasActiveBot) return "请选择正在运行的 Agent。";
  if (!input.botRunning) return "Agent 运行中后才能使用备份或恢复任务。";
  if (input.resetting) return "Agent 维护任务执行中，请稍后再试。";
  if (!input.hasEmail) return "请先在账号页绑定邮箱。";
  if (input.currentTask && isWorkspaceActionRunning(input.currentTask.status)) {
    return input.currentTask.kind === "export" ? "当前已有 Agent 备份任务运行中。" : "当前已有 Agent 恢复任务运行中。";
  }
  return null;
}
