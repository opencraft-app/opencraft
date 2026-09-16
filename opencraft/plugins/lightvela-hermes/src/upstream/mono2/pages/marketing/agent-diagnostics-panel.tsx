// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { RotateCcw, Wrench } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useMemo, useState } from "react";

import { AgentSectionHeader } from "../../components/domain/agent-section-header";
import { useT } from "../../i18n/t";
import { toast } from "../../lib/toast";
import { DiagnosticLogView, MaintenanceActionCardView } from "./agent-diagnostics-views";
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
    <div className="agents-ui space-y-4">
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
          <MaintenanceActionCardView
            icon={<Wrench className="h-3 w-3" />}
            title={t("重置模型配置")}
            description={t("初始化 Hermes Agent 的模型配置，适合修复模型配置")}
            action={resetConfigAction}
            loadingLabel={t("恢复中...")} executeLabel={t("执行")}
          />
          {isMainBot && <MaintenanceActionCardView
            icon={<RotateCcw className="h-3 w-3" />}
            title={t("重置 Hermes（保留数据）")}
            description={t("重置 Hermes 运行环境并保留数据，期间所有 Bot 将暂时不可用")}
            action={resetAgentAction}
            loadingLabel={t("重置中...")} executeLabel={t("执行")}
            consoleLines={resetAgentConsole}
            consoleRef={resetAgentConsoleRef}
          />}
        </div>
        {workspaceRecoveryPanel}
        {commands.map((item) => (
          <DiagnosticLogView key={item.id}
            title={t("最近日志")} description={t("查询或导出 Hermes Agent 最近日志，辅助定位问题")}
            command={item.command} status={states[item.id].status} output={states[item.id].output}
            exporting={exportingLogs} since={logsSince}
            options={LOGS_SINCE_VALUES.map((value) => ({ value, label: getLogsSinceLabel(value, t) }))}
            labels={{ range: t("选择日志时间段"), query: t("查询"), querying: t("查询中..."), export: t("导出"), empty: t("最近日志"), exportHint: t("可导出当前时间范围内返回的日志") }}
            onSinceChange={handleLogsSinceChange} onQuery={() => void runCommand(item)} onExport={() => void exportLogs()} />

        ))}
      </div>
    </div>
  );
}
