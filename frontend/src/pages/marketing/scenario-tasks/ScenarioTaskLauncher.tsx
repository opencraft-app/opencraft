import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useOpenClaw } from "@/contexts/agent-context";
import { useT } from "@/i18n/t";
import {
  AGENT_SECTION_PATH_BY_ID,
  AGENTS_HOME_PATH,
  SUBSCRIBE_PATH,
  getAgentCreatingPath,
} from "@/lib/agent-routes";
import {
  CronCommandError,
  createEffectiveWindowScriptName,
  createCronJobWithScriptRollback,
  ensureCleanCronDelivery,
  execCommand,
  listCronJobs,
  removeCronJob,
  writeEffectiveWindowScript,
  type CronJob,
} from "@/lib/hermes-cron-client";
import {
  listInstalledSkillSlugs,
  type InstalledSkillLoadState,
} from "@/lib/hermes-skills-client";

import { buildScenarioSendCommands, isScenarioOnceCronJob, parseEnabledScenarioChannels } from "../scenario-task-cron";
import { ScenarioInstallModal } from "./ScenarioInstallModal";
import { getScenarioTaskPack, type ScenarioTaskPack } from "./scenario-packs";
import {
  clearPendingScenarioInstall,
  readPendingScenarioInstall,
  savePendingScenarioInstall,
} from "./scenario-pending-install";
import {
  buildScenarioTaskDraft,
  isScenarioPreviewJobName,
  isScenarioRecurringJobName,
  type ScenarioTaskDraft,
} from "./scenario-task-builder";

const MAX_SCENARIO_CRON_JOBS = 20;

type ScenarioMutationStatus = "creating" | "enabling";

type ScenarioTaskNotice = {
  message: string;
  tone: "success" | "error" | "info";
};

export type ScenarioTaskLauncherRenderProps = {
  installedScenarioIds: ReadonlySet<string>;
  myTasksHref: string;
  openScenarioInstaller: (pack: ScenarioTaskPack) => void;
};

type ScenarioTaskLauncherProps = {
  packs: readonly ScenarioTaskPack[];
  children: (props: ScenarioTaskLauncherRenderProps) => ReactNode;
};

export function getScenarioActivationPrerequisite({
  isLoggedIn,
  isSubscribed,
  botId,
  botsLoading,
}: {
  isLoggedIn: boolean;
  isSubscribed: boolean;
  botId: string | null;
  botsLoading: boolean;
}): "wait" | "subscribe" | "create-agent" | "ready" {
  if (!isLoggedIn || !isSubscribed) return "subscribe";
  if (!botId && botsLoading) return "wait";
  if (!botId) return "create-agent";
  return "ready";
}

export function isDuplicateScenarioDraft(
  jobs: readonly Pick<CronJob, "prompt" | "deliver" | "schedule">[],
  draft: Pick<ScenarioTaskDraft, "generatedPrompt" | "generatedDeliver" | "recurringSchedule" | "oneShotSchedule" | "runMode">,
): boolean {
  const expectedSchedule = draft.runMode === "one-shot" ? draft.oneShotSchedule : draft.recurringSchedule;
  return jobs.some((job) => {
    const jobSchedule = job.schedule.expr || job.schedule.display;
    return job.prompt.trim() === draft.generatedPrompt.trim()
      && (job.deliver || "local") === draft.generatedDeliver
      && jobSchedule.trim() === expectedSchedule.trim();
  });
}

export function getPendingScenarioSkillResumeState(
  skill: string | undefined,
  loadState: InstalledSkillLoadState,
): "ready" | "wait" | "reselect" {
  const selectedSkill = skill?.trim();
  if (!selectedSkill) return "ready";
  if (loadState.status === "idle" || loadState.status === "loading") return "wait";
  if (loadState.status === "error") return "reselect";
  return loadState.slugs.includes(selectedSkill) ? "ready" : "reselect";
}

export function resolvePendingScenarioDeliver(
  deliver: string,
  enabledChannels: Set<string> | null,
): string | null {
  if (!enabledChannels) return null;
  const requestedTargets = deliver
    .split(",")
    .map((target) => target.trim())
    .filter((target) => target && target !== "local");
  if (!requestedTargets.length) return null;
  const connectedTargets = requestedTargets.filter((target) => enabledChannels.has(target));
  return connectedTargets.length === requestedTargets.length
    ? connectedTargets.join(",")
    : null;
}

function isTerminalScenarioCronStatus(status: string | null | undefined): boolean {
  const normalized = (status || "").trim().toLowerCase();
  return ["ok", "success", "succeeded", "done", "completed", "failed", "failure", "error"].includes(normalized);
}

function isFinishedScenarioOnceCronJob(job: CronJob): boolean {
  if (!isScenarioOnceCronJob(job)) return false;
  if (job.last_run_at && !job.next_run_at) return true;
  return isTerminalScenarioCronStatus(job.last_status);
}

async function sendScenarioStartNotice(
  botId: string,
  draft: ScenarioTaskDraft,
  t: ReturnType<typeof useT>,
): Promise<void> {
  if (draft.generatedDeliver === "local") return;
  const message = t("{{name}} 已开始处理，结果会稍后推送到{{deliver}}。", {
    name: draft.generatedName,
    deliver: draft.generatedDeliverLabel,
  });
  try {
    await Promise.allSettled(
      buildScenarioSendCommands(draft.generatedDeliver, message)
        .map((command) => execCommand(botId, command)),
    );
  } catch {
    // 接单确认失败不阻断已经创建的 Hermes Cron。
  }
}

function ScenarioTaskToast({ notice, onClose }: { notice: ScenarioTaskNotice; onClose: () => void }) {
  const toneClass = notice.tone === "success" ? "bg-[#0F8A4B]" : notice.tone === "info" ? "bg-black/80" : "bg-[#B91C1C]";
  return (
    <div className="fixed inset-x-0 top-4 z-[300] flex justify-center px-4" role="status" aria-live="polite">
      <div className={"inline-flex max-w-[min(92vw,720px)] items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-white shadow-lg " + toneClass}>
        <span className="truncate">{notice.message}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition hover:bg-white/15"
          aria-label="关闭"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function ScenarioTaskLauncher({ packs, children }: ScenarioTaskLauncherProps) {
  const t = useT();
  const { isLoggedIn, isSubscribed, bots, botsLoading, addBot } = useOpenClaw();
  const botId = bots[0]?.id ?? null;
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [jobsStatus, setJobsStatus] = useState<"loading" | "ready">("loading");
  const [enabledChannels, setEnabledChannels] = useState<Set<string> | null>(null);
  const [channelStatus, setChannelStatus] = useState<"loading" | "ready">("loading");
  const [installedSkillLoadState, setInstalledSkillLoadState] = useState<InstalledSkillLoadState>({
    status: "idle",
    slugs: [],
    error: null,
  });
  const installedSkillSlugsRef = useRef<string[]>([]);
  const [scenarioInstallPack, setScenarioInstallPack] = useState<ScenarioTaskPack | null>(null);
  const [scenarioDraft, setScenarioDraft] = useState<ScenarioTaskDraft | null>(null);
  const [scenarioMutationStatus, setScenarioMutationStatus] = useState<ScenarioMutationStatus | null>(null);
  const [notice, setNotice] = useState<ScenarioTaskNotice | null>(null);
  const resumeAttemptedRef = useRef(false);

  const myTasksHref = isLoggedIn && botId
    ? AGENT_SECTION_PATH_BY_ID.automations
    : AGENTS_HOME_PATH;

  const activeJobs = useMemo(
    () => jobs.filter((job) => !isFinishedScenarioOnceCronJob(job)),
    [jobs],
  );
  const installedScenarioIds = useMemo(() => new Set(
    packs
      .filter((pack) => activeJobs.some((job) => isScenarioRecurringJobName({ generatedName: pack.name }, job.name) && !isScenarioOnceCronJob(job)))
      .map((pack) => pack.id),
  ), [activeJobs, packs]);
  const jobLimitReached = activeJobs.length >= MAX_SCENARIO_CRON_JOBS;

  const showNotice = useCallback((message: string, tone: ScenarioTaskNotice["tone"] = "info") => {
    setNotice({ message, tone });
  }, []);

  const showError = useCallback((message: string) => {
    showNotice(message, "error");
  }, [showNotice]);

  const refreshJobs = useCallback(async () => {
    if (!botId) {
      setJobs([]);
      setJobsStatus("ready");
      return [];
    }
    setJobsStatus("loading");
    const list = await listCronJobs(botId);
    setJobs(list);
    setJobsStatus("ready");
    return list;
  }, [botId]);

  const refreshChannelStatus = useCallback(async () => {
    if (!botId) {
      setEnabledChannels(new Set());
      setChannelStatus("ready");
      return;
    }
    setChannelStatus("loading");
    try {
      const result = await execCommand(botId, "acli channel status");
      setEnabledChannels(parseEnabledScenarioChannels(result.output));
    } catch {
      setEnabledChannels(null);
    } finally {
      setChannelStatus("ready");
    }
  }, [botId]);

  const refreshInstalledSkills = useCallback(async (): Promise<InstalledSkillLoadState> => {
    if (!botId) {
      installedSkillSlugsRef.current = [];
      const nextState: InstalledSkillLoadState = { status: "ready", slugs: [], error: null };
      setInstalledSkillLoadState(nextState);
      return nextState;
    }

    setInstalledSkillLoadState({
      status: "loading",
      slugs: installedSkillSlugsRef.current,
      error: null,
    });
    try {
      const slugs = await listInstalledSkillSlugs(botId);
      installedSkillSlugsRef.current = slugs;
      const nextState: InstalledSkillLoadState = { status: "ready", slugs, error: null };
      setInstalledSkillLoadState(nextState);
      return nextState;
    } catch (error) {
      const nextState: InstalledSkillLoadState = {
        status: "error",
        slugs: installedSkillSlugsRef.current,
        error: error instanceof Error ? error.message : String(error),
      };
      setInstalledSkillLoadState(nextState);
      return nextState;
    }
  }, [botId]);

  useEffect(() => {
    void refreshJobs().catch(() => {
      setJobs([]);
      setJobsStatus("ready");
    });
  }, [refreshJobs]);

  useEffect(() => {
    void refreshChannelStatus();
  }, [refreshChannelStatus]);

  useEffect(() => {
    installedSkillSlugsRef.current = [];
    setInstalledSkillLoadState({ status: "idle", slugs: [], error: null });
    void refreshInstalledSkills();
  }, [botId, refreshInstalledSkills]);

  useEffect(() => {
    if (!botId) return;
    void ensureCleanCronDelivery(botId).catch(() => {
      // 老实例若暂时无法写配置，仍允许用户查看和管理已有任务。
    });
  }, [botId]);

  const openScenarioInstaller = useCallback((pack: ScenarioTaskPack) => {
    setScenarioDraft(null);
    setScenarioInstallPack(pack);
  }, []);

  const continueAfterPrerequisites = useCallback(async (draft: ScenarioTaskDraft): Promise<boolean> => {
    const prerequisite = getScenarioActivationPrerequisite({
      isLoggedIn,
      isSubscribed,
      botId,
      botsLoading,
    });
    if (prerequisite === "ready") return false;

    savePendingScenarioInstall({
      scenarioId: draft.scenarioId,
      values: draft.values,
      userPrompt: draft.userPrompt,
      deliver: draft.generatedDeliver,
      skill: draft.skillIds[0] ?? "",
    });
    setScenarioDraft(draft);

    if (prerequisite === "wait") {
      showNotice(t("Agent 准备好后会自动继续"));
      return true;
    }
    if (prerequisite === "subscribe") {
      window.location.assign(SUBSCRIBE_PATH);
      return true;
    }

    setScenarioMutationStatus("creating");
    try {
      const createdBot = await addBot({
        name: "我的Hermes",
        personality: "默认设定",
        personalityEmoji: "✨",
        intro: "",
        soulTemplateId: undefined,
        status: "running",
      });
      window.location.assign(getAgentCreatingPath(createdBot.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setScenarioMutationStatus(null);
      showError(t("创建 Agent 失败：{{message}}", { message }));
    }
    return true;
  }, [addBot, botId, botsLoading, isLoggedIn, isSubscribed, showError, showNotice, t]);

  const handleScenarioRunOnce = useCallback(async (draft: ScenarioTaskDraft) => {
    if (await continueAfterPrerequisites(draft)) return;
    if (!botId) {
      showError(t("Agent 尚未准备好，请稍后重试"));
      return;
    }
    if (jobLimitReached) {
      showError(t("定时任务数量已达上限，请先删除不需要的任务后再执行。"));
      return;
    }
    const pack = getScenarioTaskPack(draft.scenarioId);
    const nextDraft = buildScenarioTaskDraft({
      pack,
      values: draft.values,
      now: new Date(),
      deliver: draft.generatedDeliver,
      userPrompt: draft.userPrompt,
      selectedSkill: draft.skillIds[0] ?? "",
    });
    if (isDuplicateScenarioDraft(activeJobs, nextDraft)) {
      showError(t("相同设置已在运行，请到“我的定时任务”中修改。"));
      return;
    }
    setScenarioDraft(nextDraft);
    setScenarioMutationStatus("creating");
    try {
      await createCronJobWithScriptRollback(botId, {
        name: nextDraft.oneShotJobName,
        prompt: nextDraft.generatedPrompt,
        schedule: nextDraft.oneShotSchedule,
        skills: nextDraft.skillIds,
        deliver: nextDraft.generatedDeliver,
        pinCurrentModel: true,
      });
      void sendScenarioStartNotice(botId, nextDraft, t);
      await refreshJobs();
      clearPendingScenarioInstall();
      setScenarioInstallPack(null);
      setScenarioMutationStatus(null);
      showNotice(
        nextDraft.runMode === "one-shot"
          ? t("已安排这一次，结果会按时推送。")
          : t("已开始执行一次，结果会稍后推送。"),
        "success",
      );
    } catch (err) {
      const message = err instanceof CronCommandError ? err.message : err instanceof Error ? err.message : String(err);
      setScenarioMutationStatus(null);
      setScenarioInstallPack(getScenarioTaskPack(draft.scenarioId));
      showError(t("执行场景任务失败：{{message}}", { message }));
    }
  }, [activeJobs, botId, continueAfterPrerequisites, jobLimitReached, refreshJobs, showError, showNotice, t]);

  const handleScenarioEnableDirect = useCallback(async (draft: ScenarioTaskDraft) => {
    if (await continueAfterPrerequisites(draft)) return;
    if (!botId) {
      showError(t("Agent 尚未准备好，请稍后重试"));
      return;
    }
    if (isDuplicateScenarioDraft(activeJobs, draft)) {
      showError(t("相同设置已在运行，请到“我的定时任务”中修改。"));
      return;
    }
    setScenarioDraft(draft);
    const scenarioTrialJob = jobs.find((job) => isScenarioPreviewJobName(draft, job.name) && isScenarioOnceCronJob(job));
    if (jobLimitReached && !scenarioTrialJob) {
      showError(t("定时任务数量已达上限，请先删除不需要的任务后再启用场景"));
      return;
    }
    setScenarioMutationStatus("enabling");
    try {
      if (jobLimitReached && scenarioTrialJob) {
        await removeCronJob(botId, scenarioTrialJob.id);
      }
      const script = draft.recurringDailyTimes.length > 1
        || draft.effectiveStartAt
        || draft.effectiveEndAt
        ? createEffectiveWindowScriptName(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
        : undefined;
      if (script) {
        await writeEffectiveWindowScript(botId, script, {
          start_at: draft.effectiveStartAt,
          end_at: draft.effectiveEndAt,
          daily_times: draft.recurringDailyTimes,
        });
      }
      const createPayload = {
        name: draft.generatedName,
        prompt: draft.generatedPrompt,
        schedule: draft.recurringSchedule,
        skills: draft.skillIds,
        deliver: draft.generatedDeliver,
        pinCurrentModel: true,
      };
      if (script) {
        await createCronJobWithScriptRollback(botId, { ...createPayload, script }, script);
      } else {
        await createCronJobWithScriptRollback(botId, createPayload);
      }
      await refreshJobs();
      clearPendingScenarioInstall();
      setScenarioInstallPack(null);
      setScenarioMutationStatus(null);
      showNotice(t("已添加为定时任务，后续会按设置频率提醒"), "success");
    } catch (err) {
      const message = err instanceof CronCommandError ? err.message : err instanceof Error ? err.message : String(err);
      setScenarioMutationStatus(null);
      setScenarioInstallPack(getScenarioTaskPack(draft.scenarioId));
      showError(t("添加场景定时任务失败：{{message}}", { message }));
    }
  }, [activeJobs, botId, continueAfterPrerequisites, jobLimitReached, jobs, refreshJobs, showError, showNotice, t]);

  useEffect(() => {
    if (resumeAttemptedRef.current || botId || botsLoading || !isLoggedIn || !isSubscribed) return;
    const pending = readPendingScenarioInstall();
    if (!pending) return;
    const pack = packs.find((item) => item.id === pending.scenarioId);
    if (!pack) {
      clearPendingScenarioInstall();
      return;
    }
    const draft = buildScenarioTaskDraft({
      pack,
      values: pending.values,
      deliver: pending.deliver,
      userPrompt: pending.userPrompt,
      selectedSkill: pending.skill ?? "",
      now: new Date(),
    });
    resumeAttemptedRef.current = true;
    setScenarioDraft(draft);
    setScenarioInstallPack(pack);
    void continueAfterPrerequisites(draft);
  }, [botId, botsLoading, continueAfterPrerequisites, isLoggedIn, isSubscribed, packs]);

  useEffect(() => {
    if (resumeAttemptedRef.current || !botId || channelStatus !== "ready" || jobsStatus !== "ready") return;
    const pending = readPendingScenarioInstall();
    if (!pending) return;
    const pack = packs.find((item) => item.id === pending.scenarioId);
    if (!pack) {
      clearPendingScenarioInstall();
      return;
    }

    const skillResumeState = getPendingScenarioSkillResumeState(
      pending.skill,
      installedSkillLoadState,
    );
    if (skillResumeState === "wait") return;

    const connectedDeliver = resolvePendingScenarioDeliver(pending.deliver, enabledChannels);
    const draft = buildScenarioTaskDraft({
      pack,
      values: pending.values,
      deliver: connectedDeliver ?? pending.deliver,
      userPrompt: pending.userPrompt,
      selectedSkill: pending.skill ?? "",
      now: new Date(),
    });
    resumeAttemptedRef.current = true;
    setScenarioDraft(draft);

    if (!connectedDeliver || skillResumeState === "reselect") {
      setScenarioInstallPack(pack);
      return;
    }
    if (draft.runMode === "one-shot") void handleScenarioRunOnce(draft);
    else void handleScenarioEnableDirect(draft);
  }, [
    botId,
    channelStatus,
    enabledChannels,
    handleScenarioEnableDirect,
    handleScenarioRunOnce,
    installedSkillLoadState,
    jobsStatus,
    packs,
  ]);

  const closeScenarioInstaller = useCallback(() => {
    const pending = readPendingScenarioInstall();
    if (pending?.scenarioId === scenarioInstallPack?.id) clearPendingScenarioInstall();
    setScenarioInstallPack(null);
    setScenarioDraft(null);
  }, [scenarioInstallPack?.id]);

  return (
    <section className="w-full">
      {children({ installedScenarioIds, myTasksHref, openScenarioInstaller })}

      {notice ? <ScenarioTaskToast notice={notice} onClose={() => setNotice(null)} /> : null}

      {botsLoading && !botId ? (
        <ScenarioTaskToast notice={{ message: t("正在加载你的 Agent，请稍候"), tone: "info" }} onClose={() => setNotice(null)} />
      ) : null}

      {scenarioInstallPack ? (
        <ScenarioInstallModal
          pack={scenarioInstallPack}
          botId={botId ?? undefined}
          submitting={scenarioMutationStatus === "creating" || scenarioMutationStatus === "enabling"}
          initialValues={scenarioDraft?.scenarioId === scenarioInstallPack.id ? scenarioDraft.values : undefined}
          initialUserPrompt={scenarioDraft?.scenarioId === scenarioInstallPack.id ? scenarioDraft.userPrompt : undefined}
          initialDeliver={scenarioDraft?.scenarioId === scenarioInstallPack.id ? scenarioDraft.generatedDeliver : undefined}
          initialSkill={scenarioDraft?.scenarioId === scenarioInstallPack.id ? scenarioDraft.skillIds[0] : undefined}
          enabledChannels={enabledChannels}
          channelStatus={channelStatus}
          skillLoadState={installedSkillLoadState}
          deferDeliverySetup={getScenarioActivationPrerequisite({
            isLoggedIn,
            isSubscribed,
            botId,
            botsLoading,
          }) !== "ready"}
          onRefreshChannels={refreshChannelStatus}
          onRefreshSkills={refreshInstalledSkills}
          onClose={closeScenarioInstaller}
          onRunOnce={handleScenarioRunOnce}
          onEnableDirect={handleScenarioEnableDirect}
        />
      ) : null}

    </section>
  );
}
