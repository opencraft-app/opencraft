import { AlertCircle, CheckCircle2, Download, ExternalLink, Info, Loader2, RefreshCw, RotateCw, Wrench } from "lucide-react";
import type { ReactNode, RefObject, TransitionEventHandler } from "react";
import { AgentState, agentButtonClassName, agentPanelClassName } from "@/components/agents";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";

export const DEEPSEEK_HARNESS_LOGO_URL = "/assets/deepseek-harness-logo.svg";

export interface DeepSeekHarnessRuntimeViewProps {
  status: "loading" | "error" | "not-installed" | "installing" | "installed";
  restartPhase: "idle" | "restarting" | "completed";
  installationOperation: "install" | "repair";
  installationProgress: number;
  operationError: string | null;
  isCardTransparent: boolean;
  isRuntimeHealthy: boolean;
  liveAnnouncement: string;
  runtimeStatusLabel: string;
  webUiUrl: string;
  installationStatusRef: RefObject<HTMLDivElement | null>;
  webUiLinkRef: RefObject<HTMLAnchorElement | null>;
  onTransitionEnd: TransitionEventHandler<HTMLElement>;
  onRetry: () => void;
  onRestart: () => void;
  onRepair: () => void;
  onInstall: () => void;
  children?: ReactNode;
}

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


export function DeepSeekHarnessRuntimeView({
  status, restartPhase, installationOperation, installationProgress, operationError,
  isCardTransparent, isRuntimeHealthy, liveAnnouncement, runtimeStatusLabel, webUiUrl,
  installationStatusRef, webUiLinkRef, onTransitionEnd, onRetry, onRestart, onRepair, onInstall, children,
}: DeepSeekHarnessRuntimeViewProps) {
  const t = useT();
  return (
    <div className="agents-ui min-w-0 space-y-4">
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
        onTransitionEnd={onTransitionEnd}
        className={cn(
          agentPanelClassName,
          "p-4 transition-opacity duration-200 motion-reduce:opacity-100 motion-reduce:transition-none sm:p-5",
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
              <AgentState kind="error" title={operationError} className="mt-3" />
              <Button
                type="button"
                onClick={onRetry}
                variant="outline" className={cn(agentButtonClassName, "mt-4")}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                {t("重试")}
              </Button>
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
                  <div className={cn("mt-2 flex items-center gap-2 text-sm font-medium", isRuntimeHealthy ? "text-[#178a43]" : "text-[var(--text-secondary)]")}>
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
                <Button asChild className={cn(agentButtonClassName, "w-full sm:w-auto")}><a
                  ref={webUiLinkRef}
                  href={webUiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("访问 WebUI")}
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a></Button>
                <Button variant="outline"
                  type="button"
                  onClick={onRestart}
                  disabled={restartPhase === "restarting"}
                  className={cn(agentButtonClassName, "w-full sm:w-auto")}
                >
                  {restartPhase === "restarting" ? (
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <RotateCw className="size-4" aria-hidden="true" />
                  )}
                  {restartPhase === "restarting" ? t("重启中...") : t("重启")}
                </Button>
                <Button
                  type="button"
                  onClick={onRepair}
                  disabled={restartPhase === "restarting"}
                  className={cn(agentButtonClassName, "w-full sm:w-auto")}
                >
                  <Wrench className="size-4" aria-hidden="true" />
                  {t("修复")}
                </Button>
              </div>
            </div>
            {operationError && <AgentState kind="error" title={operationError} className="mt-4" />}
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
                  {operationError && <AgentState kind="error" title={operationError} className="mb-3" />}
                  <Button
                    type="button"
                    onClick={onInstall}
                    className={cn(agentButtonClassName, "w-full sm:w-auto")}
                  >
                    <Download className="size-4" aria-hidden="true" />
                    {operationError ? t("重新尝试安装") : t("即刻安装体验")}
                  </Button>
                </div>
              ) : (
                <div
                  ref={installationStatusRef}
                  role="group"
                  aria-label={installationOperation === "repair"
                    ? t("DeepSeek Harness 修复状态")
                    : t("DeepSeek Harness 安装状态")}
                  tabIndex={-1}
                  className="mt-5 w-full rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-black/75">
                      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      {installationOperation === "repair"
                        ? t("正在修复 DeepSeek Harness")
                        : t("正在安装 DeepSeek Harness")}
                    </span>
                    <span className="text-xs tabular-nums text-black/45">{installationProgress}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={installationOperation === "repair"
                      ? t("DeepSeek Harness 修复进度")
                      : t("DeepSeek Harness 安装进度")}
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

      {children}
    </div>
  );
}
