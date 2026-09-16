import { lazy, Suspense, useEffect, useRef, useState } from "react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { HermesAgentConsoleHost } from "./hermes-agent-console-host";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../upstream/mono2/components/ui/dialog";
import { getHermesScriptCommands } from "../upstream/mono2/pages/marketing/agent-config/scripts-runtime";
import {
  ACLI_RESET_COMMAND,
  hermesModelName,
  hermesSwitchModelFullId,
  isExecCommandSucceeded,
  truncateExecOutput,
} from "../upstream/mono2/pages/marketing/agent-reset-config";
import { toast } from "../upstream/mono2/lib/toast";
import { useT } from "../upstream/mono2/i18n/t";

const AgentDiagnosticsPanel = lazy(async () => {
  const module = await import("../upstream/mono2/pages/marketing/agent-diagnostics-panel");
  return { default: module.AgentDiagnosticsPanel };
});

type ConfirmAction = "reset-config" | "reset-agent" | null;

function redact(value: string, secret: string): string {
  return secret ? value.replaceAll(secret, "sk-***") : value;
}

export function HermesDiagnosticsManagementView({ account, botId, botName, botStatus }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
  readonly botName: string;
  readonly botStatus: string;
}) {
  const t = useT();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [resettingConfig, setResettingConfig] = useState(false);
  const [resettingAgent, setResettingAgent] = useState(false);
  const [resetAgentConsole, setResetAgentConsole] = useState<string[]>([]);
  const resetAgentConsoleRef = useRef<HTMLPreElement | null>(null);
  const runnable = botStatus.trim().toLowerCase() === "running";

  useEffect(() => {
    const element = resetAgentConsoleRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [resetAgentConsole]);

  useEffect(() => {
    setConfirmAction(null);
    setResetAgentConsole([]);
  }, [botId]);

  const resetConfig = async () => {
    if (!runnable || resettingConfig) return;
    setConfirmAction(null);
    setResettingConfig(true);
    try {
      const reset = await account.resetInstanceConfig(botId);
      const backend = await account.execDebugCommand(botId, "acli backend reset-config", { timeoutMs: 120_000 });
      if (!isExecCommandSucceeded(backend)) {
        throw new Error(t("初始化配置文件失败：{{detail}}", {
          detail: truncateExecOutput(backend.output, backend.status),
        }));
      }

      const commands = getHermesScriptCommands();
      const save = await account.execDebugCommand(botId, commands.getProviderSaveCommand({
        name: reset.config.providerName,
        baseUrl: reset.config.baseUrl,
        api: reset.config.api,
        apiKey: reset.config.apiKey,
        models: [{ id: reset.config.modelId, name: hermesModelName(reset.config.modelId) }],
      }), { timeoutMs: 120_000 });
      if (!isExecCommandSucceeded(save)) {
        throw new Error(t("默认模型保存失败：{{detail}}", {
          detail: truncateExecOutput(redact(save.output, reset.config.apiKey), save.status),
        }));
      }

      const switched = await account.execDebugCommand(
        botId,
        commands.getModelSwitchCommand(hermesSwitchModelFullId(reset.config.providerName, reset.config.modelId)),
        { timeoutMs: 120_000 },
      );
      if (!isExecCommandSucceeded(switched)) {
        throw new Error(t("默认模型切换失败：{{detail}}", {
          detail: truncateExecOutput(redact(switched.output, reset.config.apiKey), switched.status),
        }));
      }
      toast.success(t("重置成功"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("重置失败，请重试"));
    } finally {
      setResettingConfig(false);
    }
  };

  const resetAgent = async () => {
    if (!runnable || resettingAgent) return;
    setConfirmAction(null);
    setResettingAgent(true);
    setResetAgentConsole([`$ ${ACLI_RESET_COMMAND}`]);
    try {
      const result = await account.execDebugCommandStream(botId, ACLI_RESET_COMMAND, ({ stream, chunk }) => {
        setResetAgentConsole((current) => [...current, `[${stream}] ${chunk}`].slice(-80));
      }, { timeoutMs: 30 * 60_000 });
      if (!isExecCommandSucceeded(result)) {
        throw new Error(truncateExecOutput(result.output, result.status));
      }
      setResetAgentConsole([]);
      toast.success(t("Agent 重置成功"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("Agent 重置失败，请重试");
      setResetAgentConsole((current) => [...current, `[error] ${message}`].slice(-80));
      toast.error(t("Agent 重置失败，请重试"));
    } finally {
      setResettingAgent(false);
    }
  };

  const blockedTooltip = runnable ? "" : t("实例运行后才能执行此操作");
  return (
    <HermesAgentConsoleHost>
      <Suspense fallback={<div className="flex min-h-48 items-center justify-center text-sm text-black/45">{t("加载中...")}</div>}>
        {/* The account catalog exposes one physical Hermes instance, so its
            Agent-scoped maintenance surface owns the main profile. */}
        <AgentDiagnosticsPanel
          botId={botId}
          profileId="main"
          botName={botName}
          isMainBot
          execDebugCommand={(targetBotId, command) => account.execDebugCommand(targetBotId, command, { timeoutMs: 120_000 })}
          execDebugCommandStream={(targetBotId, command, onChunk) =>
            account.execDebugCommandStream(targetBotId, command, onChunk, { timeoutMs: 120_000 })
          }
          resetConfigAction={{
            disabled: !runnable || resettingConfig || resettingAgent,
            loading: resettingConfig,
            tooltip: blockedTooltip,
            onExecute: () => setConfirmAction("reset-config"),
          }}
          resetAgentAction={{
            disabled: !runnable || resettingAgent || resettingConfig,
            loading: resettingAgent,
            tooltip: blockedTooltip,
            onExecute: () => setConfirmAction("reset-agent"),
          }}
          resetAgentConsole={resetAgentConsole}
          resetAgentConsoleRef={resetAgentConsoleRef}
        />
      </Suspense>

      <Dialog open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
        <DialogContent className="rounded-lg border border-black/10 bg-white p-6 shadow-xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmAction === "reset-agent" ? t("确认重装 Agent？") : t("确认重置模型配置？")}
            </DialogTitle>
            <DialogDescription className="leading-6 text-black/55">
              {confirmAction === "reset-agent"
                ? t("将重新安装 Agent 运行环境，并保留已有数据。运行期间请勿重复操作。")
                : t("将轮换模型凭据并重新写入默认模型配置。")}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="h-9 rounded-md border border-black/10 bg-white px-4 text-sm font-semibold text-black/65 hover:bg-black/[0.03]" onClick={() => setConfirmAction(null)}>
              {t("取消")}
            </button>
            <button
              type="button"
              className="h-9 rounded-md bg-black px-4 text-sm font-semibold text-white hover:bg-black/85"
              onClick={() => void (confirmAction === "reset-agent" ? resetAgent() : resetConfig())}
            >
              {t("确认执行")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </HermesAgentConsoleHost>
  );
}
