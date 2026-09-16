import { type TransitionEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import {
  DeepSeekHarnessCommandClient,
  type DeepSeekHarnessExecDebugCommand,
  type DeepSeekHarnessRegion,
  type DeepSeekHarnessStatus,
} from "@/lib/deepseek-harness-command";
import { isCN } from "@/lib/region";
import { DeepSeekHarnessRuntimeView } from "./agent-deepseek-harness-runtime-view";
export { DEEPSEEK_HARNESS_LOGO_URL } from "./agent-deepseek-harness-runtime-view";
import { AgentDeepSeekHarnessModelCard } from "@/pages/marketing/agent-deepseek-harness-model-card";
import { DeepSeekHarnessRepairDialog } from "@/pages/marketing/agent-deepseek-harness-repair-dialog";

export const buildDeepSeekHarnessWebUiUrl = (botId: string, region: DeepSeekHarnessRegion) =>
  `https://${botId}.dsh.${region === "cn" ? "lightvela.tech" : "lightvela.site"}`;

const INSTALLATION_POLL_INTERVAL_MS = 1_500;
const INSTALLATION_COMPLETE_HOLD_MS = 250;
const MAX_POLL_ERRORS = 4;
const INSTALLATION_STAGE_SOFT_CEILING: Readonly<Record<string, number>> = {
  preflight: 19,
  resolve_latest: 27,
  snapshot_resolved: 34,
  runtime_lockfile: 47,
  runtime_install: 51,
  browser_trust_patch: 55,
  profile_lockfile: 67,
  profile_install: 74,
  validate_candidate: 84,
  activate: 94,
  health_check: 98,
  cleanup: 99,
  completed: 100,
};

const advanceInstallationProgress = (current: number, actual: number, stage: string) => {
  const normalizedActual = Math.max(1, Math.min(100, actual));
  const ceiling = Math.max(normalizedActual, INSTALLATION_STAGE_SOFT_CEILING[stage] ?? normalizedActual);
  const next = Math.min(ceiling, Math.max(normalizedActual, current + 1));
  return Math.max(current, next);
};

type ViewStatus = "loading" | "error" | "not-installed" | "installing" | "installed";
type RestartPhase = "idle" | "restarting" | "completed";
type InstallationOperation = "install" | "repair";
type CardTransition = "idle" | "fading-out" | "fading-in-start" | "fading-in";

const taskStorageKey = (botId: string) => `lightvela:dsh:install-task:${botId}`;
const taskOperationStorageKey = (botId: string) => `lightvela:dsh:install-task-operation:${botId}`;

const readTaskId = (botId: string) => {
  try {
    return window.localStorage.getItem(taskStorageKey(botId));
  } catch {
    return null;
  }
};

const readTaskOperation = (botId: string): InstallationOperation => {
  try {
    return window.localStorage.getItem(taskOperationStorageKey(botId)) === "repair" ? "repair" : "install";
  } catch {
    return "install";
  }
};

const saveTask = (botId: string, taskId: string, operation: InstallationOperation) => {
  try {
    window.localStorage.setItem(taskStorageKey(botId), taskId);
    window.localStorage.setItem(taskOperationStorageKey(botId), operation);
  } catch {
    // The running task remains recoverable through a fresh install request if storage is unavailable.
  }
};

const clearTaskId = (botId: string) => {
  try {
    window.localStorage.removeItem(taskStorageKey(botId));
    window.localStorage.removeItem(taskOperationStorageKey(botId));
  } catch {
    // Storage cleanup is best effort only.
  }
};

const toErrorMessage = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message.trim() : "";
  return message && message !== "DeepSeek Harness API is unavailable" ? message : fallback;
};

interface AgentDeepSeekHarnessPanelProps {
  botId: string;
  clientFactory?: (
    botId: string,
    execDebugCommand: DeepSeekHarnessExecDebugCommand,
  ) => DeepSeekHarnessCommandClient;
}

const defaultClientFactory = (
  botId: string,
  execDebugCommand: DeepSeekHarnessExecDebugCommand,
) => new DeepSeekHarnessCommandClient(botId, execDebugCommand);

export const AgentDeepSeekHarnessPanel = ({
  botId,
  clientFactory = defaultClientFactory,
}: AgentDeepSeekHarnessPanelProps) => {
  const t = useT();
  const repositories = useRepositories();
  const webUiUrl = buildDeepSeekHarnessWebUiUrl(botId, isCN ? "cn" : "global");
  const client = useMemo(
    () => clientFactory(botId, repositories.bots.execDebugCommand),
    [botId, clientFactory, repositories.bots.execDebugCommand],
  );
  const [status, setStatus] = useState<ViewStatus>("loading");
  const [runtime, setRuntime] = useState<DeepSeekHarnessStatus | null>(null);
  const [installationProgress, setInstallationProgress] = useState(0);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [restartPhase, setRestartPhase] = useState<RestartPhase>("idle");
  const [installationOperation, setInstallationOperation] = useState<InstallationOperation>("install");
  const [repairDialogOpen, setRepairDialogOpen] = useState(false);
  const [cardTransition, setCardTransition] = useState<CardTransition>("idle");
  const pollTimerRef = useRef<number | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const animationFrameIdsRef = useRef<Set<number>>(new Set());
  const mountedRef = useRef(true);
  const installationStatusRef = useRef<HTMLDivElement | null>(null);
  const webUiLinkRef = useRef<HTMLAnchorElement | null>(null);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const scheduleAnimationFrame = useCallback((callback: () => void) => {
    let frameId = 0;
    frameId = window.requestAnimationFrame(() => {
      animationFrameIdsRef.current.delete(frameId);
      callback();
    });
    animationFrameIdsRef.current.add(frameId);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPollTimer();
      if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current);
      animationFrameIdsRef.current.forEach((frameId) => window.cancelAnimationFrame(frameId));
      animationFrameIdsRef.current.clear();
    };
  }, [clearPollTimer]);

  useEffect(() => {
    if (status === "installing") installationStatusRef.current?.focus();
  }, [status]);

  const finishInstallation = useCallback((nextRuntime: DeepSeekHarnessStatus) => {
    setRuntime(nextRuntime);
    setInstallationProgress(100);
    clearTaskId(botId);
    if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current);
    transitionTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current) return;
      const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      if (prefersReducedMotion) {
        setStatus("installed");
        scheduleAnimationFrame(() => webUiLinkRef.current?.focus());
        return;
      }
      setCardTransition("fading-out");
    }, INSTALLATION_COMPLETE_HOLD_MS);
  }, [botId, scheduleAnimationFrame]);

  const restoreAfterOperationFailure = useCallback(async (
    operation: InstallationOperation,
    message: string,
  ) => {
    if (operation === "install") {
      setStatus("not-installed");
      setOperationError(message);
      return;
    }
    try {
      const nextRuntime = await client.getStatus();
      if (!mountedRef.current) return;
      setRuntime(nextRuntime);
      setStatus(nextRuntime.installed ? "installed" : "not-installed");
      setOperationError(message);
    } catch (statusError) {
      if (!mountedRef.current) return;
      setRuntime(null);
      setStatus("error");
      setOperationError(toErrorMessage(statusError, message));
    }
  }, [client]);

  const pollInstallation = useCallback(async (
    taskId: string,
    operation: InstallationOperation,
    consecutiveErrors = 0,
  ): Promise<void> => {
    clearPollTimer();
    try {
      const task = await client.getInstallation(taskId);
      if (!mountedRef.current) return;
      setInstallationProgress((current) => advanceInstallationProgress(current, task.progress, task.stage));

      if (task.status === "failed") {
        clearTaskId(botId);
        await restoreAfterOperationFailure(
          operation,
          task.error || task.message || (operation === "repair"
            ? t("DeepSeek Harness 修复失败，请稍后重试")
            : t("DeepSeek Harness 安装失败，请重新尝试")),
        );
        return;
      }
      if (task.status === "succeeded") {
        const nextRuntime = await client.getStatus();
        if (!mountedRef.current) return;
        if (!nextRuntime.installed) throw new Error(t("安装已完成，正在等待服务就绪"));
        finishInstallation(nextRuntime);
        return;
      }

      pollTimerRef.current = window.setTimeout(() => {
        void pollInstallation(taskId, operation, 0);
      }, INSTALLATION_POLL_INTERVAL_MS);
    } catch (pollError) {
      if (!mountedRef.current) return;
      if (consecutiveErrors + 1 < MAX_POLL_ERRORS) {
        pollTimerRef.current = window.setTimeout(() => {
          void pollInstallation(taskId, operation, consecutiveErrors + 1);
        }, INSTALLATION_POLL_INTERVAL_MS);
        return;
      }
      clearTaskId(botId);
      await restoreAfterOperationFailure(
        operation,
        toErrorMessage(pollError, operation === "repair"
          ? t("修复状态查询失败，请稍后重试")
          : t("安装状态查询失败，请重新尝试")),
      );
    }
  }, [botId, clearPollTimer, client, finishInstallation, restoreAfterOperationFailure, t]);

  const loadStatus = useCallback(async () => {
    clearPollTimer();
    setStatus("loading");
    setRuntime(null);
    setOperationError(null);
    setRestartPhase("idle");
    setRepairDialogOpen(false);
    setInstallationProgress(0);
    setCardTransition("idle");
    const existingTaskId = readTaskId(botId);
    if (existingTaskId) {
      const operation = readTaskOperation(botId);
      setInstallationOperation(operation);
      setStatus("installing");
      setInstallationProgress(1);
      void pollInstallation(existingTaskId, operation);
      return;
    }
    try {
      const nextRuntime = await client.getStatus();
      if (!mountedRef.current) return;
      if (nextRuntime.installed) {
        setRuntime(nextRuntime);
        setStatus("installed");
        return;
      }
      setStatus("not-installed");
    } catch (statusError) {
      if (!mountedRef.current) return;
      setStatus("error");
      setOperationError(toErrorMessage(statusError, t("DeepSeek Harness 状态加载失败，请稍后重试")));
    }
  }, [botId, clearPollTimer, client, pollInstallation, t]);

  useEffect(() => {
    void loadStatus();
    return clearPollTimer;
  }, [clearPollTimer, loadStatus]);

  const handleInstall = async () => {
    if (status !== "not-installed") return;
    setOperationError(null);
    setInstallationOperation("install");
    setInstallationProgress(1);
    setStatus("installing");
    try {
      const task = await client.startInstall();
      if (!mountedRef.current) return;
      saveTask(botId, task.task_id, "install");
      await pollInstallation(task.task_id, "install");
    } catch (installError) {
      if (!mountedRef.current) return;
      clearTaskId(botId);
      setStatus("not-installed");
      setOperationError(toErrorMessage(installError, t("DeepSeek Harness 安装启动失败，请重新尝试")));
    }
  };

  const handleRepair = async () => {
    if (status !== "installed") return;
    setRepairDialogOpen(false);
    setOperationError(null);
    setInstallationOperation("repair");
    setInstallationProgress(1);
    setStatus("installing");
    try {
      const task = await client.startInstall("repair");
      if (!mountedRef.current) return;
      saveTask(botId, task.task_id, "repair");
      await pollInstallation(task.task_id, "repair");
    } catch (repairError) {
      if (!mountedRef.current) return;
      clearTaskId(botId);
      setStatus("installed");
      setOperationError(toErrorMessage(repairError, t("DeepSeek Harness 修复启动失败，请稍后重试")));
    }
  };

  const handleRestart = async () => {
    if (status !== "installed" || restartPhase === "restarting") return;
    setRestartPhase("restarting");
    setOperationError(null);
    try {
      const nextRuntime = await client.restart();
      if (!mountedRef.current) return;
      setRuntime(nextRuntime);
      if (!nextRuntime.healthy) {
        setRestartPhase("idle");
        setOperationError(t("DeepSeek Harness 已重启，但 WebUI 尚未就绪"));
        return;
      }
      setRestartPhase("completed");
    } catch (restartError) {
      if (!mountedRef.current) return;
      setRestartPhase("idle");
      setOperationError(toErrorMessage(restartError, t("DeepSeek Harness 重启失败，请稍后重试")));
    }
  };

  const handleCardTransitionEnd = (event: TransitionEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "opacity") return;
    if (cardTransition === "fading-out") {
      setStatus("installed");
      setCardTransition("fading-in-start");
      scheduleAnimationFrame(() => {
        scheduleAnimationFrame(() => setCardTransition("fading-in"));
      });
      return;
    }
    if (cardTransition === "fading-in") {
      setCardTransition("idle");
      webUiLinkRef.current?.focus();
    }
  };

  const isCardTransparent = cardTransition === "fading-out" || cardTransition === "fading-in-start";
  const isRuntimeHealthy = runtime?.healthy === true && runtime.status === "running";
  const isRuntimeDegraded = runtime?.service_status === "active" && !isRuntimeHealthy;
  const liveAnnouncement = status === "installing"
    ? installationOperation === "repair"
      ? t("正在修复 DeepSeek Harness")
      : t("正在安装 DeepSeek Harness")
    : restartPhase === "restarting"
      ? t("正在重启 DeepSeek Harness")
      : restartPhase === "completed"
        ? t("DeepSeek Harness 已重新启动")
        : status === "installed"
          ? isRuntimeHealthy
            ? t("DeepSeek Harness 已安装并运行中")
            : isRuntimeDegraded
              ? t("DeepSeek Harness 已安装，但 WebUI 当前不可访问")
              : t("DeepSeek Harness 已安装")
          : "";
  const runtimeStatusLabel = restartPhase === "restarting"
    ? t("重启中...")
    : isRuntimeHealthy
      ? t("运行中")
      : isRuntimeDegraded
        ? t("运行异常")
        : t("已安装");

  return (
    <DeepSeekHarnessRuntimeView
      status={status}
      restartPhase={restartPhase}
      installationOperation={installationOperation}
      installationProgress={installationProgress}
      operationError={operationError}
      isCardTransparent={isCardTransparent}
      isRuntimeHealthy={isRuntimeHealthy}
      liveAnnouncement={liveAnnouncement}
      runtimeStatusLabel={runtimeStatusLabel}
      webUiUrl={webUiUrl}
      installationStatusRef={installationStatusRef}
      webUiLinkRef={webUiLinkRef}
      onTransitionEnd={handleCardTransitionEnd}
      onRetry={() => void loadStatus()}
      onRestart={() => void handleRestart()}
      onRepair={() => setRepairDialogOpen(true)}
      onInstall={() => void handleInstall()}
    >
      {status === "installed" && (
        <AgentDeepSeekHarnessModelCard botId={botId} region={isCN ? "cn" : "global"} />
      )}

      <DeepSeekHarnessRepairDialog
        returnFocusRef={installationStatusRef}
        open={repairDialogOpen}
        onOpenChange={setRepairDialogOpen}
        onConfirm={() => void handleRepair()}
      />
    </DeepSeekHarnessRuntimeView>
  );
};
