import { AlertTriangle } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  execCommand,
  listCronJobs,
  shellQuote,
  type CronJob,
} from "@/lib/hermes-cron-client";
import { toast } from "@/lib/toast";
import { useT } from "@/i18n/t";
import { isCronJobExpired } from "@/pages/marketing/agent-automations-panel";
import type { DebugExecCommandLifecycle } from "@/pages/marketing/agent-debug-exec-lifecycle";

const MODEL_SYNC_OUTPUT_PREFIX = "LIGHTVELA_CRON_MODEL_SYNC=";

export interface ModelSwitchTarget {
  provider: string;
  model: string;
}

export interface AutomationModelSyncCandidate {
  id: string;
  name: string;
  pinProvider: boolean;
  pinModel: boolean;
}

export interface AutomationModelSyncSummary {
  total: number;
  succeeded: number;
  failed: Array<{ id: string; error: string }>;
}

type ModelSwitchChoice = "switch-only" | "sync-automations";

interface ModelSwitchPlan {
  target: ModelSwitchTarget;
  candidates: AutomationModelSyncCandidate[];
  choice: ModelSwitchChoice;
}

export interface AutomationModelSwitchDecisionRequest {
  target: ModelSwitchTarget;
  candidates: AutomationModelSyncCandidate[];
  unknownJobCount: number;
  checkError: string | null;
  resolve: (choice: ModelSwitchChoice) => void;
  reject: (error: Error) => void;
}

/** 只识别 Tea SDK 生成的 Hermes 模型切换命令，不影响 provider save 等命令。 */
export function parseModelSwitchTarget(command: string): ModelSwitchTarget | null {
  const match = /\bacli\s+model\s+switch\s+--model\s+'((?:'\\''|[^'])*)'/i.exec(command);
  const encoded = match?.[1] ?? "";
  const model = encoded.replace(/'\\''/g, "'").trim();
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return null;
  return { provider: model.slice(0, separator), model };
}

/** 选择尚未使用目标 provider/model 的推理任务；已匹配目标的任务不重复更新。 */
export function selectAutomationModelSyncCandidates(
  jobs: readonly CronJob[],
  target: ModelSwitchTarget,
): AutomationModelSyncCandidate[] {
  const targetModel = target.model.slice(target.provider.length + 1);
  return jobs.flatMap((job) => {
    const inference = job.inference_config;
    if (!inference || inference.no_agent) return [];
    const pinProvider = inference.provider !== target.provider;
    const pinModel = inference.model !== targetModel;
    if (!pinProvider && !pinModel) return [];
    return [{ id: job.id, name: job.name, pinProvider, pinModel }];
  });
}

/**
 * 在 Hermes 自身虚拟环境内调用官方 cronjob update tool。
 * provider/model 均使用模型切换命令中的目标值，避免同步期间读取到另一份全局配置。
 */
export function buildPinAutomationModelsCommand(
  candidates: readonly AutomationModelSyncCandidate[],
  target: ModelSwitchTarget,
): string {
  const plan = candidates.map(({ id, pinProvider, pinModel }) => ({
    id,
    pin_provider: pinProvider,
    pin_model: pinModel,
  }));
  const script = [
    "import json",
    "from tools.cronjob_tools import cronjob",
    `plan = json.loads(${JSON.stringify(JSON.stringify(plan))})`,
    `provider = ${JSON.stringify(target.provider)}`,
    `model = ${JSON.stringify(target.model.slice(target.provider.length + 1))}`,
    "if not provider or not model: raise RuntimeError('current provider/model is unavailable')",
    "failed = []",
    "succeeded = 0",
    "for item in plan:",
    "    try:",
    "        kwargs = {}",
    "        if item.get('pin_provider'): kwargs['provider'] = provider",
    "        if item.get('pin_model'): kwargs['model'] = model",
    "        result = json.loads(cronjob(action='update', job_id=item['id'], **kwargs))",
    "        if result.get('success'):",
    "            succeeded += 1",
    "        else:",
    "            failed.append({'id': item['id'], 'error': str(result.get('error') or 'update failed')})",
    "    except Exception as exc:",
    "        failed.append({'id': item['id'], 'error': str(exc)})",
    `print(${JSON.stringify(MODEL_SYNC_OUTPUT_PREFIX)} + json.dumps({'total': len(plan), 'succeeded': succeeded, 'failed': failed}, ensure_ascii=False))`,
  ].join("\n");
  return `cd "$HOME/.hermes/hermes-agent" && ./venv/bin/python -c ${shellQuote(script)}`;
}

export function parseAutomationModelSyncOutput(output: string): AutomationModelSyncSummary {
  const markerIndex = output.lastIndexOf(MODEL_SYNC_OUTPUT_PREFIX);
  if (markerIndex < 0) throw new Error("automatic task synchronization result is missing");
  const line = output.slice(markerIndex + MODEL_SYNC_OUTPUT_PREFIX.length).split("\n", 1)[0]?.trim() ?? "";
  const parsed = JSON.parse(line) as Partial<AutomationModelSyncSummary>;
  if (!Number.isInteger(parsed.total) || !Number.isInteger(parsed.succeeded) || !Array.isArray(parsed.failed)) {
    throw new Error("automatic task synchronization result is invalid");
  }
  return {
    total: parsed.total!,
    succeeded: parsed.succeeded!,
    failed: parsed.failed.map((item) => ({
      id: String(item?.id ?? ""),
      error: String(item?.error ?? "update failed"),
    })),
  };
}

async function pinAutomationModels(
  botId: string,
  candidates: readonly AutomationModelSyncCandidate[],
  target: ModelSwitchTarget,
): Promise<AutomationModelSyncSummary> {
  const result = await execCommand(botId, buildPinAutomationModelsCommand(candidates, target));
  return parseAutomationModelSyncOutput(result.output || "");
}

export function useAutomationAwareModelSwitch(): {
  commandLifecycle: DebugExecCommandLifecycle;
  confirmationDialog: ReactNode;
} {
  const t = useT();
  const [decisionRequest, setDecisionRequest] = useState<AutomationModelSwitchDecisionRequest | null>(null);

  const askForDecision = useCallback((request: Omit<AutomationModelSwitchDecisionRequest, "resolve" | "reject">) => (
    new Promise<ModelSwitchChoice>((resolve, reject) => {
      setDecisionRequest({ ...request, resolve, reject });
    })
  ), []);

  const commandLifecycle = useMemo<DebugExecCommandLifecycle>(() => ({
    beforeExecute: async ({ botId, command }) => {
      const target = parseModelSwitchTarget(command);
      if (!target) return undefined;

      let candidates: AutomationModelSyncCandidate[];
      let unknownJobCount: number;
      try {
        const jobs = await listCronJobs(botId);
        const updatableJobs = jobs.filter((job) => !isCronJobExpired(job));
        candidates = selectAutomationModelSyncCandidates(updatableJobs, target);
        unknownJobCount = updatableJobs.filter((job) => job.inference_config === null).length;
      } catch (error) {
        const choice = await askForDecision({
          target,
          candidates: [],
          unknownJobCount: 0,
          checkError: error instanceof Error ? error.message : t("定时任务检查失败"),
        });
        return { target, candidates: [], choice } satisfies ModelSwitchPlan;
      }

      if (candidates.length === 0 && unknownJobCount === 0) {
        return { target, candidates, choice: "switch-only" } satisfies ModelSwitchPlan;
      }
      const choice = await askForDecision({
        target,
        candidates,
        unknownJobCount,
        checkError: null,
      });
      return { target, candidates, choice } satisfies ModelSwitchPlan;
    },
    afterExecute: async ({ botId, metadata, result }) => {
      const plan = metadata as ModelSwitchPlan | undefined;
      if (!plan || plan.choice !== "sync-automations" || plan.candidates.length === 0) return;
      if (result.exitCode !== 0 || !["SUCCESS", "SUCCEEDED"].includes(result.status)) return;

      try {
        const summary = await pinAutomationModels(botId, plan.candidates, plan.target);
        if (summary.failed.length === 0) {
          toast.success(t("模型已切换，并同步更新 {{count}} 个定时任务。", { count: summary.succeeded }));
          return;
        }
        toast.error(t("模型已切换；定时任务同步成功 {{succeeded}} 个，失败 {{failed}} 个。", {
          succeeded: summary.succeeded,
          failed: summary.failed.length,
        }), 5000);
      } catch (error) {
        toast.error(t("模型已切换，但定时任务同步失败：{{message}}", {
          message: error instanceof Error ? error.message : t("未知错误"),
        }), 5000);
      }
    },
  }), [askForDecision, t]);

  const settleDecision = useCallback((choice: ModelSwitchChoice) => {
    if (!decisionRequest) return;
    setDecisionRequest(null);
    decisionRequest.resolve(choice);
  }, [decisionRequest]);
  const cancelDecision = useCallback(() => {
    if (!decisionRequest) return;
    setDecisionRequest(null);
    decisionRequest.reject(new Error(t("已取消模型切换")));
  }, [decisionRequest, t]);

  return {
    commandLifecycle,
    confirmationDialog: decisionRequest ? (
      <AutomationModelSwitchDialog
        request={decisionRequest}
        onCancel={cancelDecision}
        onChoose={settleDecision}
      />
    ) : null,
  };
}

export function AutomationModelSwitchDialog({
  request,
  onCancel,
  onChoose,
}: {
  request: AutomationModelSwitchDecisionRequest;
  onCancel: () => void;
  onChoose: (choice: ModelSwitchChoice) => void;
}) {
  const t = useT();
  const hasSyncCandidates = request.candidates.length > 0;
  const hasDetectionGap = request.checkError !== null || request.unknownJobCount > 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="rounded-md border border-black/[0.08] bg-white p-5 shadow-xl md:w-[32rem]">
        <DialogHeader className="mb-5 pr-8">
          <DialogTitle>{t("定时任务更新提示")}</DialogTitle>
          {hasSyncCandidates ? (
            <DialogDescription className="space-y-2 text-pretty leading-relaxed">
              <span className="block">
                {t("检测到 {{count}} 个定时任务需要更新。", { count: request.candidates.length })}
              </span>
              <span className="block">
                {t("切换模型后，如不同时更新任务使用的模型，这些任务将无法正常执行。建议同步更新，后续执行时将按新模型来消耗 Token。")}
              </span>
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {hasDetectionGap ? (
          <div className="mb-5 flex gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="leading-relaxed">
              {request.checkError
                ? t("暂时无法检查定时任务。为避免误改任务，只能继续切换聊天模型或取消。")
                : t("有 {{count}} 个定时任务的模型绑定状态暂时无法确认，本次不会修改这些任务。", { count: request.unknownJobCount })}
            </p>
          </div>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("取消切换")}
          </Button>
          <Button type="button" variant="outline" onClick={() => onChoose("switch-only")}>
            {t("仅切换对话模型")}
          </Button>
          {hasSyncCandidates ? (
            <Button type="button" onClick={() => onChoose("sync-automations")}>
              {t("同步更新定时任务")}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
