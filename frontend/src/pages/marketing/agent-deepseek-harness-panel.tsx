import { AlertCircle, CheckCircle2, Download, ExternalLink, Info, Loader2, RefreshCw, RotateCw } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { AgentDeepSeekHarnessModelCard } from "@/pages/marketing/agent-deepseek-harness-model-card";

export const DEEPSEEK_HARNESS_LOGO_URL =
  "/assets/deepseek-harness-logo.svg";

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
type CardTransition = "idle" | "fading-out" | "fading-in-start" | "fading-in";

const taskStorageKey = (botId: string) => `lightvela:dsh:install-task:${botId}`;

const readTaskId = (botId: string) => {
  try {
    return window.localStorage.getItem(taskStorageKey(botId));
  } catch {
    return null;
  }
};

const saveTaskId = (botId: string, taskId: string) => {
  try {
    window.localStorage.setItem(taskStorageKey(botId), taskId);
  } catch {
    // The running task remains recoverable through a fresh install request if storage is unavailable.
  }
};

const clearTaskId = (botId: string) => {
  try {
    window.localStorage.removeItem(taskStorageKey(botId));
  } catch {
    // Storage cleanup is best effort only.
  }
};

const toErrorMessage = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message.trim() : "";
  return message && message !== "DeepSeek Harness API is unavailable" ? message : fallback;
};

const DeepSeekHarnessTitle = () => (
  <h2 className="text-[18px] font-semibold leading-6 tracking-normal text-black/[0.95]">
    <span
      aria-label="DeepSeek Harness Beta"
      className="inline-flex flex-wrap items-center gap-2 text-balance"
    >
      <span>DeepSeek Harness</span>
      <span className="inline-flex h-6 items-center rounded-full border border-black/[0.08] bg-black/[0.025] px-2 text-xs font-semibold text-black/50">
        Beta
      </span>
    </span>
  </h2>
);

const DeepSeekHarnessLogo = () => (
  <img
    src={DEEPSEEK_HARNESS_LOGO_URL}
    alt="DeepSeek Harness Logo"
    loading="lazy"
    className="size-14 shrink-0 rounded-md border border-black/[0.06] bg-white object-contain p-2"
  />
);

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

  const pollInstallation = useCallback(async (taskId: string, consecutiveErrors = 0): Promise<void> => {
    clearPollTimer();
    try {
      const task = await client.getInstallation(taskId);
      if (!mountedRef.current) return;
      setInstallationProgress((current) => advanceInstallationProgress(current, task.progress, task.stage));

      if (task.status === "failed") {
        clearTaskId(botId);
        setStatus("not-installed");
        setOperationError(task.error || task.message || t("DeepSeek Harness 安装失败，请重新尝试"));
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
        void pollInstallation(taskId, 0);
      }, INSTALLATION_POLL_INTERVAL_MS);
    } catch (pollError) {
      if (!mountedRef.current) return;
      if (consecutiveErrors + 1 < MAX_POLL_ERRORS) {
        pollTimerRef.current = window.setTimeout(() => {
          void pollInstallation(taskId, consecutiveErrors + 1);
        }, INSTALLATION_POLL_INTERVAL_MS);
        return;
      }
      clearTaskId(botId);
      setStatus("not-installed");
      setOperationError(toErrorMessage(pollError, t("安装状态查询失败，请重新尝试")));
    }
  }, [botId, clearPollTimer, client, finishInstallation, t]);

  const loadStatus = useCallback(async () => {
    clearPollTimer();
    setStatus("loading");
    setRuntime(null);
    setOperationError(null);
    setRestartPhase("idle");
    setInstallationProgress(0);
    setCardTransition("idle");
    try {
      const nextRuntime = await client.getStatus();
      if (!mountedRef.current) return;
      if (nextRuntime.installed) {
        setRuntime(nextRuntime);
        setStatus("installed");
        return;
      }
      const existingTaskId = readTaskId(botId);
      if (existingTaskId) {
        setStatus("installing");
        setInstallationProgress(1);
        void pollInstallation(existingTaskId);
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
    setInstallationProgress(1);
    setStatus("installing");
    try {
      const task = await client.startInstall();
      if (!mountedRef.current) return;
      saveTaskId(botId, task.task_id);
      await pollInstallation(task.task_id);
    } catch (installError) {
      if (!mountedRef.current) return;
      clearTaskId(botId);
      setStatus("not-installed");
      setOperationError(toErrorMessage(installError, t("DeepSeek Harness 安装启动失败，请重新尝试")));
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
    ? t("正在安装 DeepSeek Harness")
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
    <div className="space-y-4">
      <aside
        role="note"
        aria-label={t("抢先体验公告")}
        className="flex gap-3 rounded-md border border-[#d9dde5] bg-[#f6f7f9] px-4 py-3 text-sm leading-6 text-black/65"
      >
        <Info className="mt-0.5 size-4 shrink-0 text-[#426a9b]" aria-hidden="true" />
        <ul className="min-w-0 list-disc space-y-1 pl-4">
          <li>{t("当前DeepSeek Harness安装后，会与Hermes Agent运行在同一环境")}</li>
          <li>{t("该能力尚处于抢先体验阶段，后续可能会有不兼容更新，敬请知悉")}</li>
        </ul>
      </aside>

      <section
        role="region"
        aria-label="DeepSeek Harness"
        aria-busy={status === "loading" || status === "installing" || restartPhase === "restarting"}
        onTransitionEnd={handleCardTransitionEnd}
        className={cn(
          "rounded-md border border-black/[0.08] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)] transition-opacity duration-200 motion-reduce:opacity-100 motion-reduce:transition-none sm:p-6",
          status !== "installed" && "min-h-52",
          isCardTransparent ? "opacity-0" : "opacity-100",
        )}
      >
        <p role="status" aria-live="polite" className="sr-only">{liveAnnouncement}</p>

        {status === "loading" && (
          <div className="flex min-h-36 items-center gap-4">
            <DeepSeekHarnessLogo />
            <div>
              <DeepSeekHarnessTitle />
              <div className="mt-3 flex items-center gap-2 text-sm text-black/50">
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t("正在获取安装状态")}
              </div>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="flex min-h-36 flex-col gap-4 sm:flex-row sm:items-start">
            <DeepSeekHarnessLogo />
            <div className="min-w-0 flex-1">
              <DeepSeekHarnessTitle />
              <p role="alert" className="mt-3 text-sm leading-6 text-red-600">{operationError}</p>
              <button
                type="button"
                onClick={() => void loadStatus()}
                className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-black/[0.12] bg-white px-4 text-sm font-semibold text-black/80 hover:bg-black/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/25 focus-visible:ring-offset-2"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                {t("重试")}
              </button>
            </div>
          </div>
        )}

        {status === "installed" && (
          <div>
            <div
              role="group"
              aria-label={t("DeepSeek Harness 运行信息")}
              className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-start gap-4">
                <DeepSeekHarnessLogo />
                <div className="min-w-0">
                  <DeepSeekHarnessTitle />
                  <div className={`mt-2 flex items-center gap-2 text-sm font-semibold ${isRuntimeHealthy ? "text-[#178a43]" : "text-black/55"}`}>
                    {restartPhase === "restarting" ? (
                      <Loader2 className="size-5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    ) : isRuntimeHealthy ? (
                      <CheckCircle2 className="size-5 shrink-0" aria-hidden="true" />
                    ) : (
                      <AlertCircle className="size-5 shrink-0" aria-hidden="true" />
                    )}
                    <span>
                      {runtimeStatusLabel}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                <a
                  ref={webUiLinkRef}
                  href={webUiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-md bg-black px-4 text-sm font-semibold text-white hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30 focus-visible:ring-offset-2 sm:w-auto"
                >
                  {t("访问 WebUI")}
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
                <button
                  type="button"
                  onClick={() => void handleRestart()}
                  disabled={restartPhase === "restarting"}
                  className="inline-flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-md border border-black/[0.12] bg-white px-4 text-sm font-semibold text-black/80 hover:bg-black/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/25 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-black/35 sm:w-auto"
                >
                  {restartPhase === "restarting" ? (
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <RotateCw className="size-4" aria-hidden="true" />
                  )}
                  {restartPhase === "restarting" ? t("重启中...") : t("重启")}
                </button>
              </div>
            </div>
            {operationError && <p role="alert" className="mt-4 text-sm text-red-600">{operationError}</p>}
          </div>
        )}

        {(status === "not-installed" || status === "installing") && (
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
            <DeepSeekHarnessLogo />
            <div className="min-w-0 flex-1">
              <DeepSeekHarnessTitle />
              <p className="mt-1 text-sm font-medium leading-6 text-black/50">
                <span className="text-pretty">
                  {t("DeepSeek Harness（简称：dsh）是由 DeepSeek 开发的一款采用一切皆插件架构的开源智能体框架（Agent Harness）。安装完成后即可通过 LightVela 访问专属 WebUI。")}
                </span>
              </p>

              {status === "not-installed" ? (
                <div className="mt-5">
                  {operationError && <p role="alert" className="mb-3 text-sm leading-6 text-red-600">{operationError}</p>}
                  <button
                    type="button"
                    onClick={() => void handleInstall()}
                    className="inline-flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-md bg-black px-4 text-sm font-semibold text-white hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30 focus-visible:ring-offset-2 sm:w-auto"
                  >
                    <Download className="size-4" aria-hidden="true" />
                    {operationError ? t("重新尝试安装") : t("即刻安装体验")}
                  </button>
                </div>
              ) : (
                <div
                  ref={installationStatusRef}
                  role="group"
                  aria-label={t("DeepSeek Harness 安装状态")}
                  tabIndex={-1}
                  className="mt-5 w-full focus:outline-none"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-black/75">
                      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      {t("正在安装 DeepSeek Harness")}
                    </span>
                    <span className="text-xs tabular-nums text-black/45">{installationProgress}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={t("DeepSeek Harness 安装进度")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={installationProgress}
                    className="mt-3 h-2 overflow-hidden rounded-full bg-black/[0.08]"
                  >
                    <div
                      className="h-full origin-left rounded-full bg-black transition-transform duration-150 ease-out motion-reduce:transition-none"
                      style={{ transform: `scaleX(${installationProgress / 100})` }}
                    />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-black/45">
                    {t("请稍等片刻，安装大约需要 1-3 分钟")}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {status === "installed" && (
        <AgentDeepSeekHarnessModelCard botId={botId} region={isCN ? "cn" : "global"} />
      )}
    </div>
  );
};
