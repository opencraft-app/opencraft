import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { BotSummary } from "@opencraft/mobile-bot-bridge";
import type { AutomationDraft, AutomationJob } from "@opencraft/mobile-bot-bridge";
import type { LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";
import { LIGHTVELA_REGIONS } from "@opencraft/plugin-lightvela-hermes/account-contract";
import {
  createCronJobWithScriptRollback, editCronJob, listCronJobs, listRecentCronRuns, pauseCronJob,
  removeCronJob, removeCronJobWithDependentRollback, removeManagedCronScriptIfUnreferenced,
  resumeCronJob, startCronTestRun, type CronJob, type CronTarget,
} from "../generated/native-cron-client";

export type AutomationAction = "list" | "create" | "edit" | "pause" | "resume" | "remove" | "test";
export type AutomationRun = { id: string; jobId: string; at: string; status: string | null };
export type AutomationView = {
  jobs: readonly AutomationJob[];
  runs: readonly AutomationRun[];
  loading: boolean;
  pending: AutomationAction | null;
  error: string | null;
  completed: number;
  lastCompletedAction: AutomationAction | null;
};
const emptyView: AutomationView = { jobs: [], runs: [], loading: false, pending: null, error: null, completed: 0, lastCompletedAction: null };

function projectJob(job: CronJob): AutomationJob {
  return {
    id: job.id, name: job.name, prompt: job.prompt,
    schedule: job.schedule.expr, scheduleDisplay: job.schedule.display,
    enabled: job.enabled, state: job.state, deliver: job.deliver,
    nextRunAt: job.next_run_at, lastRunAt: job.last_run_at,
    lastStatus: job.last_status, executionStatus: job.execution_status ?? null,
    kind: job.zero_token_config?.kind ?? "agent",
    contextFrom: job.context_from ?? [], contextHydrated: job.context_from_hydrated === true,
  };
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.name === "CronCommandError") return "任务服务暂时不可用，请重试";
  return cause instanceof Error && cause.message ? cause.message : "操作未完成，请重试";
}

/** The original frontend Cron client runs directly in Expo JS, with a target-scoped native port. */
export function useMobileAutomations({ scope, bot, region, token, active, onUnauthorized }: {
  scope: string; bot: BotSummary | undefined; region: LightVelaRegion; token: string;
  active: boolean; onUnauthorized(): void;
}) {
  const [view, setView] = useState<AutomationView & { identity: string }>({ ...emptyView, identity: "" });
  const generation = useRef(0);
  const pending = useRef(false);
  const targetRef = useRef<CronTarget | null>(null);
  targetRef.current = bot && token ? {
    instanceId: bot.instanceId, profileId: bot.profileId,
    apiBase: LIGHTVELA_REGIONS[region].apiBase, token,
    region, onUnauthorized,
  } : null;
  const identity = `${scope}:${bot?.id ?? ""}:${bot?.instanceId ?? ""}:${bot?.profileId ?? ""}`;
  const refreshRuns = useCallback((target: CronTarget, jobs: CronJob[], current: number) => {
    void listRecentCronRuns(target, jobs).then(runs => {
      if (generation.current === current) setView(state => ({ ...state,
        runs: runs.map(run => ({ id: run.id, jobId: run.job_id, at: run.run_at, status: run.status })),
      }));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    const target = targetRef.current;
    pending.current = active && Boolean(target);
    setView(state => state.identity === identity
      ? { ...state, loading: active && Boolean(target), pending: pending.current ? "list" : null, error: null }
      : { ...emptyView, identity, loading: active && Boolean(target), pending: pending.current ? "list" : null });
    if (active && target) void listCronJobs(target).then(jobs => {
      if (generation.current === current) {
        pending.current = false;
        setView(state => ({ ...state, jobs: jobs.map(projectJob), loading: false, pending: null }));
        refreshRuns(target, jobs, current);
      }
    }).catch(cause => {
      if (generation.current === current) {
        pending.current = false;
        setView(state => ({ ...state, loading: false, pending: null, error: errorMessage(cause) }));
      }
    });
    return () => { generation.current++; };
  }, [identity, active, refreshRuns]);

  const run = useCallback(async (action: AutomationAction, payload?: { jobId?: string; draft?: AutomationDraft; dependentIds?: string[] }) => {
    const target = targetRef.current;
    if (!target || !active || pending.current) return;
    const current = generation.current;
    pending.current = true;
    setView(state => ({ ...state, pending: action, error: null }));
    try {
      const before = await listCronJobs(target);
      const job = payload?.jobId ? before.find(item => item.id === payload.jobId) : undefined;
      if (action !== "list" && action !== "create" && !job) throw new Error("任务已更新，请刷新后重试");
      let cleanupWarning: string | null = null;
      if (action === "create") {
        if (!payload?.draft) throw new Error("任务内容不完整");
        if (before.length >= 20) throw new Error("已达到任务数量上限");
        await createCronJobWithScriptRollback(target, { ...payload.draft, pinCurrentModel: true });
      } else if (action === "edit") {
        if (!job || !payload?.draft || job.zero_token_config) throw new Error("当前任务不支持编辑");
        await editCronJob(target, job.id, payload.draft);
      } else if (action === "pause" && job) await pauseCronJob(target, job.id);
      else if (action === "resume" && job) await resumeCronJob(target, job.id);
      else if (action === "test" && job) {
        const started = await startCronTestRun(target, job);
        void started.completion.catch(cause => {
          if (generation.current === current) setView(state => ({ ...state, error: errorMessage(cause) }));
        });
      } else if (action === "remove" && job) {
        if (before.some(item => item.context_from_hydrated !== true)) throw new Error("任务关联尚未读取完整，请刷新后重试");
        const dependents = before.filter(item => item.context_from?.includes(job.id))
          .map(item => ({ id: item.id, name: item.name, contextFrom: item.context_from ?? [] }));
        const expected = [...(payload?.dependentIds ?? [])].sort();
        const actual = dependents.map(item => item.id).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("任务关联发生变化，请刷新后重试");
        if (dependents.length) await removeCronJobWithDependentRollback(target, job.id, dependents);
        else await removeCronJob(target, job.id);
        try { await removeManagedCronScriptIfUnreferenced(target, job, before); }
        catch { cleanupWarning = "任务已删除，关联文件清理未完成"; }
      }
      const jobs = action === "list" ? before : await listCronJobs(target);
      if (generation.current === current) setView(state => ({
        ...state, jobs: jobs.map(projectJob), pending: null, loading: false, error: cleanupWarning,
        completed: state.completed + 1, lastCompletedAction: action,
      }));
      if (generation.current === current) refreshRuns(target, jobs, current);
    } catch (cause) {
      if (generation.current === current) setView(state => ({ ...state, pending: null, loading: false, error: errorMessage(cause) }));
    } finally { if (generation.current === current) pending.current = false; }
  }, [active, refreshRuns]);
  useEffect(() => {
    if (!active) return;
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") void run("list");
    });
    return () => subscription.remove();
  }, [active, run]);
  // Mask the previous Bot synchronously, before the effect that starts its replacement request.
  return { view: view.identity === identity ? view : { ...emptyView, loading: active && Boolean(bot) }, run };
}
