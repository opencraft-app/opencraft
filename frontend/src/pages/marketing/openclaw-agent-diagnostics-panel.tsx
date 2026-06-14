import { ChevronDown, ClipboardList, Download, FileText, Loader2, RotateCcw, Wrench } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useT } from "@/i18n/t";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type DiagnosticCommandId = "logs";
type DiagnosticRunStatus = "idle" | "loading" | "success" | "error";

export interface DebugCommandResult {
  status: string;
  exitCode: number;
  output: string;
}

export type ExecDebugCommand = (botId: string, command: string) => Promise<DebugCommandResult>;

export interface AgentDiagnosticCommand {
  id: DiagnosticCommandId;
  command: string;
}

export type LogsSinceOption = "1h" | "3h" | "6h" | "12h" | "24h";

export const LOGS_SINCE_OPTIONS: Array<{ value: LogsSinceOption; label: string }> = [
  { value: "1h", label: "1 小时" },
  { value: "3h", label: "3 小时" },
  { value: "6h", label: "6 小时" },
  { value: "12h", label: "12 小时" },
  { value: "24h", label: "24 小时" },
];

const DEFAULT_LOGS_SINCE: LogsSinceOption = "1h";

export function buildLogsCommand(since: LogsSinceOption): string {
  return `hermes logs --since ${since} --limit 200`;
}

export function buildLogsExportCommand(since: LogsSinceOption): string {
  return `hermes logs --since ${since}`;
}

export function getAgentDiagnosticCommands(logsSince: LogsSinceOption): AgentDiagnosticCommand[] {
  return [
    {
      id: "logs",
      command: buildLogsCommand(logsSince),
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

export function buildDiagnosticLogsFileName(since: LogsSinceOption, date = new Date()): string {
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
  return `hermes-logs-${since}-${stamp}.log`;
}

function downloadDiagnosticLogs(output: string, since: LogsSinceOption) {
  const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = buildDiagnosticLogsFileName(since);
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
  execDebugCommand,
  resetConfigAction,
  resetAgentAction,
  resetAgentConsole,
  resetAgentConsoleRef,
}: {
  botId: string;
  execDebugCommand: ExecDebugCommand;
  resetConfigAction: DiagnosticsMaintenanceAction;
  resetAgentAction: DiagnosticsMaintenanceAction;
  resetAgentConsole: string[];
  resetAgentConsoleRef: RefObject<HTMLPreElement | null>;
}) {
  const t = useT();
  const [logsSince, setLogsSince] = useState<LogsSinceOption>(DEFAULT_LOGS_SINCE);
  const [exportingLogs, setExportingLogs] = useState(false);
  const commands = useMemo(() => getAgentDiagnosticCommands(logsSince), [logsSince]);
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
      const result = await execDebugCommand(botId, buildLogsExportCommand(logsSince));
      if (!isDiagnosticCommandSucceeded(result)) {
        toast.error(t("获取最近日志失败"));
        return;
      }
      downloadDiagnosticLogs(normalizeDiagnosticOutput(result.output, result.status), logsSince);
    } catch {
      toast.error(t("获取最近日志失败"));
    } finally {
      setExportingLogs(false);
    }
  }, [botId, execDebugCommand, logsSince, t]);

  const handleLogsSinceChange = useCallback((next: LogsSinceOption) => {
    setLogsSince(next);
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-black/90">{t("诊断中心")}</h2>
        <p className="mt-1 text-sm leading-6 text-black/50">{t("查看 Hermes Agent 日志，并集中执行重置相关维护操作")}</p>
      </div>

      <div className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          <MaintenanceActionCard
            icon={<Wrench className="h-3.5 w-3.5" />}
            title={t("重置模型配置")}
            description={t("初始化 Hermes Agent 的模型配置，适合修复模型配置")}
            action={resetConfigAction}
            loadingLabel={t("恢复中...")}
          />
          <MaintenanceActionCard
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            title={t("重装 Agent（保留数据）")}
            description={t("执行 Hermes Agent 后台重置流程")}
            action={resetAgentAction}
            loadingLabel={t("重置中...")}
            consoleLines={resetAgentConsole}
            consoleRef={resetAgentConsoleRef}
          />
        </div>
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
      ? t("正在获取日志，命令完成后会显示完整输出。")
      : state.output;

  return (
    <article className="flex min-h-[360px] flex-col rounded-lg border border-black/[0.08] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
      <div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-black/65">
              <Icon className="h-4 w-4" />
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
        <p className="mt-2 text-sm leading-6 text-black/50">{description}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-black/[0.035] px-3 py-2">
        <code className="truncate font-mono text-xs text-black/55">{item.command}</code>
        <div className="flex flex-shrink-0 items-center gap-2">
          {item.id === "logs" && logsSince && onLogsSinceChange && (
            <div className="relative">
              <select
                value={logsSince}
                disabled={isLoading}
                onChange={(event) => onLogsSinceChange(event.target.value as LogsSinceOption)}
                className={cn(
                  "h-7 appearance-none rounded-full border border-black/[0.08] bg-white pl-3 pr-6 text-xs font-medium text-black/60 outline-none transition-colors",
                  isLoading ? "cursor-wait opacity-60" : "hover:border-black/15 hover:text-black/80",
                )}
                aria-label={t("选择日志时间段")}
              >
                {LOGS_SINCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-black/45"
              />
            </div>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className={cn(
              "inline-flex h-7 flex-shrink-0 items-center justify-center gap-1 rounded-full bg-black px-3.5 text-sm font-semibold text-white shadow-sm transition-colors",
              isLoading ? "cursor-wait opacity-60" : "hover:bg-black/85 active:bg-black/95",
            )}
          >
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("执行")}
          </button>
        </div>
      </div>
      {item.id === "logs" && (
        <p className="mt-2 text-xs leading-5 text-black/40">{t("仅展示最近 200 条，完整日志可执行导出操作")}</p>
      )}

      <div className="mt-4 min-h-0 flex-1 rounded-md border border-black/[0.06] bg-black/[0.025]">
        {state.status === "idle" ? (
          <div className="flex h-full min-h-[190px] items-center justify-center p-5 text-center text-sm text-black/40">
            <ClipboardList className="mr-2 h-4 w-4" />
            {item.id === "logs" ? t("点击执行获取最近日志") : t("点击执行获取诊断结果")}
          </div>
        ) : (
          <DiagnosticOutput text={displayOutput} />
        )}
      </div>

    </article>
  );
}

function getCommandTitle(t: ReturnType<typeof useT>): string {
  return t("最近日志");
}

function getCommandDescription(t: ReturnType<typeof useT>): string {
  return t("查看 Hermes Agent 最近日志，辅助定位问题");
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
            <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-black/65">
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
            "inline-flex h-7 flex-shrink-0 items-center justify-center gap-1 rounded-full bg-black px-3 text-sm font-semibold text-white shadow-sm transition-colors",
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
    <div className="relative">
      <pre
        ref={preRef}
        onScroll={recompute}
        style={{ scrollbarWidth: "none" }}
        className="lw-diagnostic-output-native max-h-[230px] overflow-y-scroll whitespace-pre-wrap break-words p-4 pr-5 font-mono text-xs leading-5 text-black/70"
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
