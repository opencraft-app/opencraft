import { ChevronDown, ClipboardList, Download, FileText, Loader2, Stethoscope } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useT } from "@/i18n/t";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type DiagnosticCommandId = "doctor" | "logs";
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
const DOCTOR_COMMAND = "hermes doctor --fix";

export function buildLogsCommand(since: LogsSinceOption): string {
  return `hermes logs --since ${since}`;
}

export function getAgentDiagnosticCommands(logsSince: LogsSinceOption): AgentDiagnosticCommand[] {
  return [
    {
      id: "doctor",
      command: DOCTOR_COMMAND,
    },
    {
      id: "logs",
      command: buildLogsCommand(logsSince),
    },
  ];
}

export const AGENT_DIAGNOSTIC_COMMANDS: AgentDiagnosticCommand[] = getAgentDiagnosticCommands(DEFAULT_LOGS_SINCE);

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
}: {
  botId: string;
  execDebugCommand: ExecDebugCommand;
}) {
  const t = useT();
  const [logsSince, setLogsSince] = useState<LogsSinceOption>(DEFAULT_LOGS_SINCE);
  const commands = useMemo(() => getAgentDiagnosticCommands(logsSince), [logsSince]);
  const [states, setStates] = useState<Record<DiagnosticCommandId, DiagnosticCardState>>({
    doctor: DEFAULT_CARD_STATE,
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

      const title = getCommandTitle(item.id, t);
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
          toast.success(`${title}：${t("正常")}`);
        } else {
          toast.error(`${title}：${t("获取失败")}`);
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
        toast.error(`${title}：${t("获取失败")}`);
      }
    },
    [botId, execDebugCommand, t],
  );

  const handleLogsSinceChange = useCallback((next: LogsSinceOption) => {
    setLogsSince(next);
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-black/90">{t("诊断中心")}</h2>
        <p className="mt-1 text-sm leading-6 text-black/50">{t("通过 Hermes doctor 和 logs 快速检查智能体运行状态")}</p>
      </div>

      <div className="grid gap-4">
        {commands.map((item) => (
          <DiagnosticCard
            key={item.id}
            item={item}
            state={states[item.id]}
            onRefresh={() => void runCommand(item)}
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
  logsSince,
  onLogsSinceChange,
}: {
  item: AgentDiagnosticCommand;
  state: DiagnosticCardState;
  onRefresh: () => void;
  logsSince?: LogsSinceOption;
  onLogsSinceChange?: (value: LogsSinceOption) => void;
}) {
  const t = useT();
  const Icon = item.id === "doctor" ? Stethoscope : FileText;
  const isLoading = state.status === "loading";
  const title = getCommandTitle(item.id, t);
  const description = getCommandDescription(item.id, t);
  const displayOutput =
    isLoading && !state.output
      ? item.id === "doctor"
        ? t("正在执行 hermes doctor --fix，命令完成后会显示完整输出。")
        : t("正在获取日志，命令完成后会显示完整输出。")
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
              onClick={() => downloadDiagnosticLogs(state.rawOutput || state.output, logsSince ?? "1h")}
              disabled={isLoading || !(state.rawOutput || state.output)}
              className={cn(
                "inline-flex h-7 flex-shrink-0 items-center justify-center gap-1 rounded-full px-2 text-xs font-medium text-black/50 transition-colors",
                isLoading || !(state.rawOutput || state.output)
                  ? "cursor-not-allowed opacity-45"
                  : "hover:bg-black/[0.04] hover:text-black/80",
              )}
            >
              <Download className="h-3.5 w-3.5" />
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
              "inline-flex h-8 flex-shrink-0 items-center justify-center gap-1.5 rounded-full bg-black px-4 text-sm font-semibold text-white shadow-sm transition-colors",
              isLoading ? "cursor-wait opacity-60" : "hover:bg-black/85 active:bg-black/95",
            )}
          >
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("执行")}
          </button>
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1 rounded-md border border-black/[0.06] bg-black/[0.025]">
        {state.status === "idle" ? (
          <div className="flex h-full min-h-[190px] items-center justify-center p-5 text-center text-sm text-black/40">
            <ClipboardList className="mr-2 h-4 w-4" />
            {item.id === "logs" ? t("点击执行获取最近日志") : t("点击执行获取诊断结果")}
          </div>
        ) : (
          <pre className="lw-diagnostic-output max-h-[230px] overflow-y-scroll whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-black/70">
            {displayOutput}
          </pre>
        )}
      </div>

    </article>
  );
}

function getCommandTitle(id: DiagnosticCommandId, t: ReturnType<typeof useT>): string {
  if (id === "doctor") return t("一键修复");
  return t("最近日志");
}

function getCommandDescription(id: DiagnosticCommandId, t: ReturnType<typeof useT>): string {
  if (id === "doctor") return t("执行 hermes doctor 命令，系统将会自动检测问题并尝试修复。");
  return t("查看 Hermes Agent 最近日志，辅助定位问题");
}
