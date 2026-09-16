// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { ChevronDown, ClipboardList, Download, FileText, Loader2, RotateCcw, Wrench } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AgentSectionHeader } from "../../components/domain/agent-section-header";
import { useT } from "../../i18n/t";
import { toast } from "../../lib/toast";
import { cn } from "../../lib/utils";
import { withHermesProfile } from "../../lib/hermes-agent-command";

type DiagnosticCommandId = "logs";
type DiagnosticRunStatus = "idle" | "loading" | "success" | "error";

export interface DebugCommandResult {
  status: string;
  exitCode: number;
  output: string;
}

export type ExecDebugCommand = (botId: string, command: string) => Promise<DebugCommandResult>;
export type ExecDebugCommandStream = (
  botId: string,
  command: string,
  onChunk: (event: { stream: string; chunk: string }) => void,
) => Promise<DebugCommandResult>;

export interface AgentDiagnosticCommand {
  id: DiagnosticCommandId;
  command: string;
}

export type LogsSinceOption = "1h" | "3h" | "6h" | "12h" | "24h";

export const LOGS_SINCE_VALUES: LogsSinceOption[] = ["1h", "3h", "6h", "12h", "24h"];

// label 走 t() 而非硬编码，避免国际站漏翻（模块级常量内无法调 hook，故在组件内本地化）
function getLogsSinceLabel(value: LogsSinceOption, t: ReturnType<typeof useT>): string {
  switch (value) {
    case "1h":
      return t("1 小时");
    case "3h":
      return t("3 小时");
    case "6h":
      return t("6 小时");
    case "12h":
      return t("12 小时");
    case "24h":
      return t("24 小时");
  }
}

const DEFAULT_LOGS_SINCE: LogsSinceOption = "1h";
const LOGS_PREVIEW_LINES = 50;
const LOGS_EXPORT_LINES = 100_000;

export function buildLogsCommand(since: LogsSinceOption, profileId = "main"): string {
  return withHermesProfile(`logs --since ${since} -n ${LOGS_PREVIEW_LINES}`, profileId);
}

export function buildLogsExportCommand(since: LogsSinceOption, profileId = "main"): string {
  return withHermesProfile(`logs --since ${since} -n ${LOGS_EXPORT_LINES}`, profileId);
}

export async function collectStreamedDiagnosticOutput(
  botId: string,
  command: string,
  execDebugCommandStream: ExecDebugCommandStream,
): Promise<DebugCommandResult> {
  let streamedOutput = "";
  const result = await execDebugCommandStream(botId, command, ({ chunk }) => {
    streamedOutput += chunk;
  });
  return {
    ...result,
    output: streamedOutput || result.output,
  };
}

export function getAgentDiagnosticCommands(logsSince: LogsSinceOption, profileId = "main"): AgentDiagnosticCommand[] {
  return [
    {
      id: "logs",
      command: buildLogsCommand(logsSince, profileId),
    },
  ];
}

export const AGENT_DIAGNOSTIC_COMMANDS: AgentDiagnosticCommand[] = getAgentDiagnosticCommands(DEFAULT_LOGS_SINCE);

export interface DiagnosticsMaintenanceAction {
  disabled: boolean;
  loading: boolean;
  tooltip: string;
  onExecute: () => void;
}

export function buildDiagnosticLogsFileName(since: LogsSinceOption, date = new Date(), botName = "main"): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
  const safeName = botName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 60) || "bot";
  return `hermes-logs-${safeName}-${since}-${stamp}.log`;
}

function downloadDiagnosticLogs(output: string, since: LogsSinceOption, botName: string) {
  const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = buildDiagnosticLogsFileName(since, new Date(), botName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function normalizeDiagnosticOutput(output: string | undefined, status: string): string {
  const trimmed = (output || "").trim();
  return trimmed || status || "暂无输出";
}

export function getDiagnosticRunStatus(result: { status: string; exitCode: number }): Exclude<DiagnosticRunStatus, "idle" | "loading"> {
  return isDiagnosticCommandSucceeded(result) ? "success" : "error";
}

function isDiagnosticCommandSucceeded(result: { status: string; exitCode: number }): boolean {
  const status = result.status.toLowerCase();
  return result.exitCode === 0 && status !== "failed" && status !== "error";
}

function truncateDiagnosticOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n...`;
}

interface DiagnosticCardState {
  status: DiagnosticRunStatus;
  output: string;
  rawOutput: string;
}

const DEFAULT_CARD_STATE: DiagnosticCardState = {
  status: "idle",
  output: "",
  rawOutput: "",
};

export function AgentDiagnosticsPanel({
  botId,
  profileId,
  botName,
  isMainBot,
  execDebugCommand,
  execDebugCommandStream,
  resetConfigAction,
  resetAgentAction,
  resetAgentConsole,
  resetAgentConsoleRef,
  workspaceRecoveryPanel,
}: {
  botId: string;
  profileId: string;
  botName: string;
  isMainBot: boolean;
  execDebugCommand: ExecDebugCommand;
  execDebugCommandStream: ExecDebugCommandStream;
  resetConfigAction: DiagnosticsMaintenanceAction;
  resetAgentAction: DiagnosticsMaintenanceAction;
  resetAgentConsole: string[];
  resetAgentConsoleRef: RefObject<HTMLPreElement | null>;
  workspaceRecoveryPanel?: ReactNode;
}) {
  const t = useT();
  const [logsSince, setLogsSince] = useState<LogsSinceOption>(DEFAULT_LOGS_SINCE);
  const [exportingLogs, setExportingLogs] = useState(false);
  const commands = useMemo(() => getAgentDiagnosticCommands(logsSince, profileId), [logsSince, profileId]);
  const [states, setStates] = useState<Record<DiagnosticCommandId, DiagnosticCardState>>({
    logs: DEFAULT_CARD_STATE,
  });

  const runCommand = useCallback(
    async (item: AgentDiagnosticCommand) => {
      setStates((current) => ({
        ...current,
        [item.id]: {
          ...current[item.id],
          status: "loading",
        },
      }));

      try {
        const result = await execDebugCommand(botId, item.command);
        const nextStatus = getDiagnosticRunStatus(result);
        const output = normalizeDiagnosticOutput(result.output, result.status);
        setStates((current) => ({
          ...current,
          [item.id]: {
            status: nextStatus,
            output: truncateDiagnosticOutput(output, 8000),
            rawOutput: output,
          },
        }));
        if (nextStatus === "success") {
          toast.success(t("获取最近日志成功"));
        } else {
          toast.error(t("获取最近日志失败"));
        }
      } catch (error) {
        const output = error instanceof Error ? error.message : t("命令执行失败");
        setStates((current) => ({
          ...current,
          [item.id]: {
            status: "error",
            output,
            rawOutput: output,
          },
        }));
        toast.error(t("获取最近日志失败"));
      }
    },
    [botId, execDebugCommand, t],
  );

  const exportLogs = useCallback(async () => {
    setExportingLogs(true);
    try {
      const result = await collectStreamedDiagnosticOutput(
        botId,
        buildLogsExportCommand(logsSince, profileId),
        execDebugCommandStream,
      );
      if (!isDiagnosticCommandSucceeded(result)) {
        toast.error(t("获取最近日志失败"));
        return;
      }
      downloadDiagnosticLogs(normalizeDiagnosticOutput(result.output, result.status), logsSince, botName);
    } catch {
      toast.error(t("获取最近日志失败"));
    } finally {
      setExportingLogs(false);
    }
  }, [botId, botName, profileId, execDebugCommandStream, logsSince, t]);

  const handleLogsSinceChange = useCallback((next: LogsSinceOption) => {
    setLogsSince(next);
  }, []);

  return (
    <div className="space-y-4">
      <AgentSectionHeader
        title={t("诊断中心")}
        description={
          isMainBot
            ? t("查看 Hermes Agent 日志，并集中执行相关维护操作")
            : t("查看当前 Bot 的日志；Agent 级维护请在主 Bot 中操作")
        }
      />

      <div className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          <MaintenanceActionCard
            icon={<Wrench className="h-3 w-3" />}
            title={t("重置模型配置")}
            description={t("初始化 Hermes Agent 的模型配置，适合修复模型配置")}
            action={resetConfigAction}
            loadingLabel={t("恢复中...")}
          />
          {isMainBot && <MaintenanceActionCard
            icon={<RotateCcw className="h-3 w-3" />}
            title={t("重装 Agent（保留数据）")}
            description={t("重装整个 Agent 并保留数据，期间所有 Bot 将暂时不可用")}
            action={resetAgentAction}
            loadingLabel={t("重置中...")}
            consoleLines={resetAgentConsole}
            consoleRef={resetAgentConsoleRef}
          />}
        </div>
        {workspaceRecoveryPanel}
        {commands.map((item) => (
          <DiagnosticCard
            key={item.id}
            item={item}
            state={states[item.id]}
            onRefresh={() => void runCommand(item)}
            onExport={item.id === "logs" ? () => void exportLogs() : undefined}
            isExporting={item.id === "logs" ? exportingLogs : false}
            logsSince={item.id === "logs" ? logsSince : undefined}
            onLogsSinceChange={item.id === "logs" ? handleLogsSinceChange : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function DiagnosticCard({
  item,
  state,
  onRefresh,
  onExport,
  isExporting,
  logsSince,
  onLogsSinceChange,
}: {
  item: AgentDiagnosticCommand;
  state: DiagnosticCardState;
  onRefresh: () => void;
  onExport?: () => void;
  isExporting?: boolean;
  logsSince?: LogsSinceOption;
  onLogsSinceChange?: (value: LogsSinceOption) => void;
}) {
  const t = useT();
  const Icon = FileText;
  const isLoading = state.status === "loading";
  const title = getCommandTitle(t);
  const description = getCommandDescription(t);
  const displayOutput =
    isLoading && !state.output
      ? t("查询中...")
      : state.output;

  return (
    <article className="flex min-h-[360px] w-full min-w-0 max-w-full flex-col rounded-lg border border-black/[0.08] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
      <div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-black/65">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <h3 className="truncate text-base font-semibold text-black/90">{title}</h3>
          </div>
          {item.id === "logs" && (
            <button
              type="button"
              onClick={onExport}
              disabled={isLoading || isExporting}
              className={cn(
                "inline-flex h-7 flex-shrink-0 items-center justify-center gap-1 rounded-full px-2 text-xs font-medium text-black/50 transition-colors",
                isLoading || isExporting
                  ? "cursor-not-allowed opacity-45"
                  : "hover:bg-black/[0.04] hover:text-black/80",
              )}
            >
              {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {t("导出")}
            </button>
          )}
        </div>
        <p className="mt-2 text-xs leading-5 text-black/50">{description}</p>
      </div>

      <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md bg-black/[0.035] px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-black/55">{item.command}</code>
        <div className="flex flex-shrink-0 items-center gap-2">
          {item.id === "logs" && logsSince && onLogsSinceChange && (
            <LogsSelectMenu
              value={logsSince}
              options={LOGS_SINCE_VALUES.map((value) => ({ value, label: getLogsSinceLabel(value, t) }))}
              disabled={isLoading}
              ariaLabel={t("选择日志时间段")}
              widthClassName="w-[92px]"
              onChange={onLogsSinceChange}
            />
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className={cn(
              "lv-button lv-button--secondary inline-flex h-7 flex-shrink-0 items-center justify-center gap-1 rounded-full bg-black px-3.5 text-sm font-semibold text-white shadow-sm transition-colors",
              isLoading ? "cursor-wait opacity-60" : "hover:bg-black/85 active:bg-black/95",
            )}
          >
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {item.id === "logs" ? t("查询") : t("执行")}
          </button>
        </div>
      </div>

      <div className="mt-4 min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border border-black/[0.06] bg-black/[0.025]">
        {state.status === "idle" ? (
          <div className="flex h-full min-h-[190px] flex-col items-center justify-center p-5 text-center text-sm text-black/40">
            <div className="flex items-center justify-center">
              <ClipboardList className="mr-2 h-4 w-4" />
              {item.id === "logs" ? (
                <span>
                  {t("点击")}
                  <button
                    type="button"
                    onClick={onRefresh}
                    className="mx-0.5 rounded px-0.5 font-medium text-black/55 underline decoration-black/20 underline-offset-2 transition-colors hover:text-black/80 hover:decoration-black/45"
                  >
                    {t("查询")}
                  </button>
                  {t("最近日志")}
                </span>
              ) : (
                t("点击执行获取诊断结果")
              )}
            </div>
            {item.id === "logs" && (
              <p className="mt-2 text-xs leading-5 text-black/35">
                    {t("可导出当前时间范围内返回的日志")}
              </p>
            )}
          </div>
        ) : (
          <DiagnosticOutput text={displayOutput} />
        )}
      </div>

    </article>
  );
}

function LogsSelectMenu<TValue extends string>({
  value,
  options,
  disabled,
  ariaLabel,
  widthClassName,
  menuWidthClassName = "w-[132px]",
  header,
  hint,
  onChange,
}: {
  value: TValue;
  options: Array<{ value: TValue; label: string }>;
  disabled: boolean;
  ariaLabel: string;
  widthClassName: string;
  menuWidthClassName?: string;
  header?: string;
  hint?: string;
  onChange: (value: TValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? "";

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div ref={menuRef} className={cn("relative", widthClassName)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-7 w-full items-center justify-between rounded-full border border-black/[0.08] bg-white pl-3 pr-2 text-left text-xs font-medium text-black/60 shadow-sm outline-none transition-colors",
          disabled ? "cursor-wait opacity-60" : "hover:border-black/15 hover:text-black/80 focus:border-black/20",
        )}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 flex-shrink-0 text-black/45 transition-transform", open && "rotate-180")} />
      </button>
      {open && !disabled && (
        <div
          className={cn(
            "absolute left-0 top-[calc(100%+6px)] z-30 rounded-xl border border-black/10 bg-white p-1.5 shadow-xl",
            menuWidthClassName,
          )}
          role="listbox"
          aria-label={ariaLabel}
        >
          {header && (
            <div className="px-3 py-1.5 text-xs font-medium leading-5 text-black/40">
              {header}
            </div>
          )}
          {options.map((option) => {
            const checked = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium leading-[22px] transition",
                  checked ? "bg-black text-white" : "text-black/70 hover:bg-black/[0.04] hover:text-black",
                )}
                role="option"
                aria-selected={checked}
              >
                {option.label}
              </button>
            );
          })}
          {hint && (
            <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium leading-4 text-black/35">
              {hint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getCommandTitle(t: ReturnType<typeof useT>): string {
  return t("最近日志");
}

function getCommandDescription(t: ReturnType<typeof useT>): string {
  return t("查询或导出 Hermes Agent 最近日志，辅助定位问题");
}

function MaintenanceActionCard({
  icon,
  title,
  description,
  action,
  loadingLabel,
  consoleLines,
  consoleRef,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: DiagnosticsMaintenanceAction;
  loadingLabel: string;
  consoleLines?: string[];
  consoleRef?: RefObject<HTMLPreElement | null>;
}) {
  const t = useT();
  return (
    <article className="rounded-lg border border-black/[0.08] bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.035)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-black/65">
              {icon}
            </span>
            <h3 className="truncate text-base font-semibold text-black/90">{title}</h3>
          </div>
          <p className="mt-2 text-xs leading-5 text-black/50">{description}</p>
          {action.disabled && !action.loading && (
            <p className="mt-2 text-xs text-black/40">{action.tooltip}</p>
          )}
        </div>
        <button
          type="button"
          onClick={action.onExecute}
          disabled={action.disabled}
          className={cn(
            "lv-button lv-button--secondary inline-flex h-7 flex-shrink-0 items-center justify-center gap-1 rounded-full bg-black px-3 text-sm font-semibold text-white shadow-sm transition-colors",
            action.disabled ? "cursor-not-allowed opacity-50" : "hover:bg-black/85 active:bg-black/95",
          )}
        >
          {action.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {action.loading ? loadingLabel : t("执行")}
        </button>
      </div>
      {consoleLines && consoleLines.length > 0 && (
        <pre
          ref={consoleRef}
          className="mt-3 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-black/[0.08] bg-[#111827] px-3 py-2.5 text-[11px] leading-relaxed text-[#d1d5db]"
        >
          {consoleLines.join("\n")}
        </pre>
      )}
    </article>
  );
}

/* 诊断输出区 + 手绘滚动条
 * ──────────────────────────────────────────────────────────
 * macOS Chromium overlay 滚动条的"hover 才显"行为受系统偏好控制，
 * 哪怕 ::-webkit-scrollbar 显式声明几何 + scrollbar-width: thin/auto
 * 都不一定能强制外显。这里改用纯 React 渲染：
 *   - <pre> 走 overflow-y: scroll，但 scrollbar-width: none 把原生
 *     滚动条彻底隐藏（连占位都不留），鼠标滚轮 / 键盘照常工作
 *   - 右侧 absolute 一根 8px 宽 track + 按比例算的 thumb
 *   - onScroll 同步 thumb 偏移；ResizeObserver 监听容器 / 内容尺寸
 *
 * 不做拖拽 thumb（用户主要靠滚轮，可视化已足够）。 */
function DiagnosticOutput({ text }: { text: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [metrics, setMetrics] = useState({ overflow: false, thumbHeight: 0, thumbTop: 0 });

  const recompute = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    const { scrollHeight, clientHeight, scrollTop } = el;
    const overflow = scrollHeight > clientHeight + 1;
    if (!overflow) {
      setMetrics({ overflow: false, thumbHeight: 0, thumbTop: 0 });
      return;
    }
    const ratio = clientHeight / scrollHeight;
    const thumbHeight = Math.max(20, clientHeight * ratio);
    const maxThumbTop = clientHeight - thumbHeight;
    const scrollRatio = scrollTop / (scrollHeight - clientHeight);
    setMetrics({ overflow: true, thumbHeight, thumbTop: scrollRatio * maxThumbTop });
  }, []);

  useLayoutEffect(() => {
    recompute();
    const el = preRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, recompute]);

  return (
    <div className="relative min-w-0 max-w-full overflow-hidden">
      <pre
        ref={preRef}
        onScroll={recompute}
        style={{ scrollbarWidth: "none" }}
        className="lw-diagnostic-output-native block max-h-[230px] w-full max-w-full overflow-y-scroll whitespace-pre-wrap break-all p-4 pr-5 font-mono text-xs leading-5 text-black/70"
      >
        {text}
      </pre>
      {metrics.overflow && (
        <div
          aria-hidden
          className="pointer-events-none absolute right-1.5 top-1.5 bottom-1.5 w-1.5 rounded-full bg-black/[0.06]"
        >
          <div
            className="absolute left-0 right-0 rounded-full bg-black/35"
            style={{ height: metrics.thumbHeight, transform: `translateY(${metrics.thumbTop}px)` }}
          />
        </div>
      )}
    </div>
  );
}
