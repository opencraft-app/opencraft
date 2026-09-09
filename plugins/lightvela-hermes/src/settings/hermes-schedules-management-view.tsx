import { CalendarClock, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsSelect,
  SettingsSwitch,
  SettingsTextInput,
} from "@opencraft/extension-react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";

import {
  createCronJobWithContextAndScriptRollback,
  createCronJobWithScriptRollback,
  createEffectiveWindowScriptName,
  createZeroTokenScriptName,
  editCronJob,
  editCronJobWithContext,
  isLightVelaEffectiveWindowScriptName,
  isLightVelaZeroTokenScriptName,
  listCronJobs,
  listRecentCronRuns,
  pauseCronJob,
  removeCronJobWithDependentRollback,
  removeManagedCronScriptIfUnreferenced,
  resumeCronJob,
  startCronTestRun,
  writeEffectiveWindowScript,
  writeZeroTokenScript,
  type CronJob,
  type CronRunRecord,
  type CronScriptLanguage,
  type CronZeroTokenKind,
} from "../management/schedules/hermes-cron-client";
import {
  getAutomationSkillSelectionIssue,
  getEligibleCronUpstreams,
  isCronJobPaused,
  isCronJobUnavailableAsUpstream,
  toCreateCronSkills,
  toCronContextPatch,
  toEditCronSkills,
  wouldCreateCronContextCycle,
} from "../management/schedules/cron-context-policy";
import {
  buildInstalledSkillsListCommand,
  parseInstalledSkillSlugs,
  type InstalledSkillLoadState,
} from "../management/skills/hermes-skills-client";

type ScheduleMode = "agent" | "fixed_notification" | "script";

function csv(value: string): string[] {
  return Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)));
}

function scheduleError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function HermesSchedulesManagementView({ account, botId }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
}) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [runs, setRuns] = useState<CronRunRecord[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [prompt, setPrompt] = useState("");
  const [deliver, setDeliver] = useState("local");
  const [selectedSkill, setSelectedSkill] = useState("");
  const [skillState, setSkillState] = useState<InstalledSkillLoadState>({ status: "idle", slugs: [], error: null });
  const [initialSkillWasAvailable, setInitialSkillWasAvailable] = useState<boolean | null>(null);
  const [selectedUpstream, setSelectedUpstream] = useState("");
  const [pinCurrentModel, setPinCurrentModel] = useState(true);
  const [mode, setMode] = useState<ScheduleMode>("agent");
  const [scriptLanguage, setScriptLanguage] = useState<CronScriptLanguage>("bash");
  const [scriptContent, setScriptContent] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [weekdays, setWeekdays] = useState("");
  const [dailyTimes, setDailyTimes] = useState("");

  const load = useCallback(async () => {
    setPending("load"); setError(null);
    try {
      const [nextJobs, skillOutput] = await Promise.all([
        listCronJobs(botId),
        account.execDebugCommand(botId, buildInstalledSkillsListCommand(), { timeoutMs: 120_000 }),
      ]);
      setJobs(nextJobs);
      setSkillState(skillOutput.exitCode === 0
        ? { status: "ready", slugs: parseInstalledSkillSlugs(skillOutput.output), error: null }
        : { status: "error", slugs: [], error: skillOutput.output || skillOutput.status });
      setRuns(await listRecentCronRuns(botId, nextJobs, 10));
    } catch (cause) {
      setSkillState({ status: "error", slugs: [], error: scheduleError(cause) });
      setError(scheduleError(cause));
    }
    finally { setPending(null); }
  }, [account, botId]);
  useEffect(() => { void load(); }, [load]);

  const resetDraft = () => {
    setEditingId(null); setName(""); setSchedule(""); setPrompt(""); setDeliver("local");
    setSelectedSkill(""); setInitialSkillWasAvailable(null); setSelectedUpstream(""); setPinCurrentModel(true); setMode("agent");
    setScriptLanguage("bash"); setScriptContent(""); setStartAt(""); setEndAt("");
    setWeekdays(""); setDailyTimes("");
  };

  const edit = (job: CronJob) => {
    setEditingId(job.id); setName(job.name); setSchedule(job.schedule.expr); setPrompt(job.prompt);
    const initialSelectedSkill = job.skills[0] ?? "";
    setDeliver(job.deliver || "local"); setSelectedSkill(initialSelectedSkill);
    setInitialSkillWasAvailable(initialSelectedSkill ? skillState.status === "ready" && skillState.slugs.includes(initialSelectedSkill) : null);
    setSelectedUpstream(job.context_from?.[0] ?? "");
    setMode(job.zero_token_config?.kind ?? "agent");
    setScriptLanguage(job.zero_token_config?.language ?? "bash");
    setScriptContent(job.zero_token_config?.content ?? "");
    setStartAt(job.effective_window?.start_at ?? ""); setEndAt(job.effective_window?.end_at ?? "");
    setWeekdays((job.effective_window?.weekdays ?? []).join(","));
    setDailyTimes((job.lightvela_schedule?.times ?? []).join(","));
  };

  const save = async () => {
    const normalizedName = name.trim();
    const normalizedSchedule = schedule.trim();
    if (!normalizedName || !normalizedSchedule || pending) return;
    setPending("save"); setError(null); setNotice(null);
    const initialJob = editingId ? jobs.find((job) => job.id === editingId) : undefined;
    const initialContextFrom = initialJob?.context_from ?? [];
    const externalMultipleUpstreams = initialContextFrom.length > 1;
    const upstreamChanged = selectedUpstream !== (initialContextFrom[0] ?? "");
    const weekdayValues = csv(weekdays).map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
    const timeValues = csv(dailyTimes);
    const hasGate = !!startAt || !!endAt || weekdayValues.length > 0 || timeValues.length > 0;
    const scriptConfig = hasGate ? {
      start_at: startAt || null,
      end_at: endAt || null,
      weekdays: weekdayValues,
      daily_times: timeValues,
    } : null;
    let zeroTokenRollback: { script: string; config: Parameters<typeof writeZeroTokenScript>[2] } | null = null;
    try {
      const initialSkills = initialJob?.skills ?? [];
      const skillSelectionChanged = selectedSkill !== (initialSkills[0] ?? "");
      let verificationState = skillState;
      if (mode === "agent"
        && selectedSkill
        && (!editingId || skillSelectionChanged || initialSkillWasAvailable === true)) {
        try {
          const result = await account.execDebugCommand(botId, buildInstalledSkillsListCommand(), { timeoutMs: 120_000 });
          verificationState = result.exitCode === 0
            ? { status: "ready", slugs: parseInstalledSkillSlugs(result.output), error: null }
            : { status: "error", slugs: [], error: result.output || result.status };
        } catch (cause) {
          verificationState = { status: "error", slugs: [], error: scheduleError(cause) };
        }
        setSkillState(verificationState);
      }
      const skillSelectionIssue = mode === "agent" ? getAutomationSkillSelectionIssue({
        mode: editingId ? "edit" : "create",
        initialSkills,
        selectedSkill,
        initialSkillWasAvailable,
        verificationState,
      }) : null;
      if (skillSelectionIssue === "unavailable") {
        throw new Error("The selected Skill is no longer available. Choose another Skill or clear the binding.");
      }
      if (skillSelectionIssue === "unverified") {
        throw new Error("The selected Skill could not be verified. Refresh and try again.");
      }

      if (editingId) {
        const initial = initialJob;
        if (!initial) throw new Error("The scheduled task no longer exists. Refresh and try again.");
        const patch: Parameters<typeof editCronJob>[2] = {
          name: normalizedName,
          schedule: normalizedSchedule,
          deliver,
        };
        if (mode === "agent") {
          patch.prompt = prompt.trim();
          const skillsPatch = toEditCronSkills(initial.skills, selectedSkill);
          if (skillsPatch !== undefined) patch.skills = skillsPatch;
          const originalManaged = isLightVelaEffectiveWindowScriptName(initial.script);
          if (scriptConfig) {
            const scriptName = originalManaged ? initial.script : createEffectiveWindowScriptName(initial.id);
            await writeEffectiveWindowScript(botId, scriptName, scriptConfig);
            patch.script = scriptName;
          } else if (originalManaged) {
            patch.script = "";
          }
        } else {
          const original = initial.zero_token_config;
          if (!original?.managed || original.content === null || !isLightVelaZeroTokenScriptName(initial.script)) {
            throw new Error("This external no-agent task is read-only because its script is not owned by LightVela.");
          }
          zeroTokenRollback = {
            script: initial.script,
            config: {
              kind: original.kind,
              language: original.language,
              content: original.content,
              start_at: initial.effective_window?.start_at ?? null,
              end_at: initial.effective_window?.end_at ?? null,
              weekdays: initial.effective_window?.weekdays ?? [],
              daily_times: initial.lightvela_schedule?.times ?? [],
            },
          };
          await writeZeroTokenScript(botId, initial.script, {
            kind: mode,
            language: mode === "fixed_notification" ? "python" : scriptLanguage,
            content: scriptContent,
            start_at: scriptConfig?.start_at ?? null,
            end_at: scriptConfig?.end_at ?? null,
            weekdays: scriptConfig?.weekdays ?? [],
            daily_times: scriptConfig?.daily_times ?? [],
          });
        }
        let contextPatch = mode === "agent" && !externalMultipleUpstreams
          ? toCronContextPatch(initialContextFrom, selectedUpstream, upstreamChanged)
          : undefined;
        if (mode === "agent" && selectedUpstream && !externalMultipleUpstreams && upstreamChanged) {
          const latestJobs = await listCronJobs(botId);
          if (latestJobs.some((job) => job.context_from_hydrated !== true)) {
            throw new Error("The latest dependency graph could not be verified. Refresh and try again.");
          }
          const latestUpstream = latestJobs.find((job) => job.id === selectedUpstream);
          if (!latestUpstream || isCronJobUnavailableAsUpstream(latestUpstream)) {
            throw new Error("The selected upstream task was removed or is no longer available.");
          }
          if (isCronJobPaused(latestUpstream)) {
            throw new Error("The selected upstream task is paused.");
          }
          if (wouldCreateCronContextCycle(latestJobs, initial.id, selectedUpstream)) {
            throw new Error("The selected upstream task would create a dependency cycle.");
          }
          contextPatch = [selectedUpstream];
        }
        await editCronJobWithContext(botId, editingId, patch, contextPatch);
      } else {
        let scriptName: string | undefined;
        if (mode !== "agent") {
          scriptName = createZeroTokenScriptName(normalizedName);
          await writeZeroTokenScript(botId, scriptName, {
            kind: mode as CronZeroTokenKind,
            language: scriptLanguage,
            content: scriptContent,
            start_at: scriptConfig?.start_at ?? null,
            end_at: scriptConfig?.end_at ?? null,
            weekdays: scriptConfig?.weekdays ?? [],
            daily_times: scriptConfig?.daily_times ?? [],
          });
        } else if (hasGate) {
          scriptName = createEffectiveWindowScriptName(normalizedName);
          await writeEffectiveWindowScript(botId, scriptName, scriptConfig!);
        }
        const input = {
          name: normalizedName,
          schedule: normalizedSchedule,
          prompt: mode === "agent" ? prompt.trim() : undefined,
          deliver,
          skills: mode === "agent" ? toCreateCronSkills(selectedSkill) : undefined,
          script: scriptName,
          noAgent: mode !== "agent",
          pinCurrentModel: mode === "agent" && pinCurrentModel,
        };
        if (selectedUpstream) {
          const latestJobs = await listCronJobs(botId);
          if (latestJobs.some((job) => job.context_from_hydrated !== true)) {
            throw new Error("The latest dependency graph could not be verified. Refresh and try again.");
          }
          const latestUpstream = latestJobs.find((job) => job.id === selectedUpstream);
          if (!latestUpstream || isCronJobUnavailableAsUpstream(latestUpstream)) {
            throw new Error("The selected upstream task was removed or is no longer available.");
          }
          if (isCronJobPaused(latestUpstream)) {
            throw new Error("The selected upstream task is paused.");
          }
          await createCronJobWithContextAndScriptRollback(botId, input, selectedUpstream, scriptName);
        } else {
          await createCronJobWithScriptRollback(botId, input, scriptName);
        }
      }
      resetDraft();
      setNotice(editingId ? "Schedule updated." : "Schedule created.");
      await load();
    } catch (cause) {
      if (zeroTokenRollback) {
        await writeZeroTokenScript(botId, zeroTokenRollback.script, zeroTokenRollback.config).catch(() => undefined);
      }
      setError(scheduleError(cause));
    }
    finally { setPending(null); }
  };

  const toggle = async (job: CronJob) => {
    setPending(`toggle:${job.id}`); setError(null);
    try { if (job.enabled) await pauseCronJob(botId, job.id); else await resumeCronJob(botId, job.id); await load(); }
    catch (cause) { setError(scheduleError(cause)); }
    finally { setPending(null); }
  };

  const test = async (job: CronJob) => {
    setPending(`test:${job.id}`); setError(null); setNotice(null);
    try {
      const started = await startCronTestRun(botId, job);
      setNotice("Test run scheduled; Hermes will deliver the result through the job's configured channel.");
      void started.completion.catch((cause) => setError(scheduleError(cause)));
    } catch (cause) { setError(scheduleError(cause)); }
    finally { setPending(null); }
  };

  const remove = async (job: CronJob) => {
    setPending(`delete:${job.id}`); setError(null);
    const dependents = jobs
      .filter((candidate) => candidate.context_from?.includes(job.id))
      .map((candidate) => ({ id: candidate.id, name: candidate.name, contextFrom: candidate.context_from ?? [] }));
    try {
      await removeCronJobWithDependentRollback(botId, job.id, dependents);
      await removeManagedCronScriptIfUnreferenced(botId, job, jobs);
      if (editingId === job.id) resetDraft();
      await load();
    } catch (cause) { setError(scheduleError(cause)); }
    finally { setPending(null); }
  };

  const byJob = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const editingJob = editingId ? byJob.get(editingId) : undefined;
  const externalMultipleUpstreams = (editingJob?.context_from?.length ?? 0) > 1;
  const eligibleUpstreams = useMemo(
    () => getEligibleCronUpstreams(jobs, editingId, Date.now()),
    [editingId, jobs],
  );
  return (
    <>
      <SettingsSection title="Schedules" icon={<CalendarClock size={16} />} description="Paused jobs remain visible; job metadata, dependencies, model binding and managed scripts are hydrated from Hermes storage." action={<SettingsButton type="button" variant="ghost" disabled={pending !== null} onClick={() => void load()}><RefreshCw size={14} /> Refresh</SettingsButton>}>
        {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
        {notice ? <SettingsNotice tone="success">{notice}</SettingsNotice> : null}
        <SettingsGroup>
          {pending === "load" && jobs.length === 0 ? <SettingsNotice>Loading jobs and recent runs…</SettingsNotice> : null}
          {jobs.map((job) => <SettingsListItem key={job.id} icon={<CalendarClock size={15} />} label={job.name} description={`${job.schedule.display || job.schedule.expr} · ${job.deliver || "local"}`} metadata={`${job.enabled ? "Active" : "Paused"}${job.execution_status ? ` · ${job.execution_status}` : ""}${job.context_from?.length ? ` · depends on ${job.context_from.map((id) => byJob.get(id)?.name ?? id).join(", ")}` : ""}`} actions={<><SettingsButton type="button" variant="ghost" disabled={pending !== null} onClick={() => edit(job)}>Edit</SettingsButton><SettingsButton type="button" variant="ghost" disabled={pending !== null} onClick={() => void test(job)}><Play size={14} /> Test</SettingsButton><SettingsButton type="button" variant="ghost" disabled={pending !== null} onClick={() => void toggle(job)}>{job.enabled ? <Pause size={14} /> : <Play size={14} />}</SettingsButton><SettingsButton type="button" variant="ghost" disabled={pending !== null} aria-label={`Delete ${job.name}`} onClick={() => void remove(job)}><Trash2 size={14} /></SettingsButton></>} />)}
          {pending !== "load" && jobs.length === 0 ? <SettingsNotice>No scheduled jobs.</SettingsNotice> : null}
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title={editingId ? "Edit scheduled task" : "Create scheduled task"} description="Supports Agent tasks, zero-token notifications/scripts, effective windows, dependencies and explicit model pinning.">
        <SettingsSegmented label="Execution mode" value={mode} disabled={!!editingId} onValueChange={(value) => setMode(value as ScheduleMode)} options={[{ value: "agent", label: "Agent" }, { value: "fixed_notification", label: "0 Token notice" }, { value: "script", label: "0 Token script" }]} />
        <SettingsGroup>
          <SettingsRow label="Name" htmlFor="cron-name"><SettingsTextInput id="cron-name" value={name} onChange={(event) => setName(event.currentTarget.value)} /></SettingsRow>
          <SettingsRow label="Schedule" description="Cron expression, every interval, or ISO date" htmlFor="cron-schedule"><SettingsTextInput id="cron-schedule" value={schedule} onChange={(event) => setSchedule(event.currentTarget.value)} placeholder="0 9 * * *" /></SettingsRow>
          {mode === "agent" ? <SettingsRow label="Prompt" htmlFor="cron-prompt" layout="stacked"><textarea id="cron-prompt" className="lightvela-management-textarea" value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} /></SettingsRow> : <SettingsRow label={mode === "script" ? "Script" : "Notification text"} htmlFor="cron-script" layout="stacked"><textarea id="cron-script" className="lightvela-management-textarea" value={scriptContent} onChange={(event) => setScriptContent(event.currentTarget.value)} /></SettingsRow>}
          {mode === "script" ? <SettingsRow label="Script language"><SettingsSegmented label="Script language" value={scriptLanguage} onValueChange={(value) => setScriptLanguage(value as CronScriptLanguage)} options={[{ value: "bash", label: "Bash" }, { value: "python", label: "Python" }]} /></SettingsRow> : null}
          <SettingsRow label="Delivery target" htmlFor="cron-deliver"><SettingsTextInput id="cron-deliver" value={deliver} onChange={(event) => setDeliver(event.currentTarget.value)} placeholder="local / origin / channel" /></SettingsRow>
          {mode === "agent" ? <SettingsRow label="Skill" description="Hermes supports one product-managed Skill binding; an unchanged legacy binding is preserved." htmlFor="cron-skills"><SettingsSelect id="cron-skills" value={selectedSkill} onChange={(event) => setSelectedSkill(event.currentTarget.value)}><option value="">No Skill</option>{selectedSkill && !skillState.slugs.includes(selectedSkill) ? <option value={selectedSkill}>{selectedSkill} (currently unavailable)</option> : null}{skillState.slugs.map((slug) => <option key={slug} value={slug}>{slug}</option>)}</SettingsSelect></SettingsRow> : null}
          <SettingsRow
            label="Depends on"
            description={externalMultipleUpstreams
              ? "This task has multiple external upstreams. Workbench preserves them read-only."
              : "Only active, non-expired tasks that cannot form a cycle are eligible."}
            htmlFor="cron-context"
          >
            <SettingsSelect
              id="cron-context"
              value={selectedUpstream}
              disabled={externalMultipleUpstreams}
              onChange={(event) => setSelectedUpstream(event.currentTarget.value)}
            >
              <option value="">No upstream task</option>
              {externalMultipleUpstreams
                ? <option value={selectedUpstream}>{editingJob?.context_from?.map((id) => byJob.get(id)?.name ?? id).join(", ")}</option>
                : eligibleUpstreams.map((job) => <option key={job.id} value={job.id}>{job.name}</option>)}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label="Start / end" description="Optional local ISO timestamps" layout="stacked"><div className="lightvela-management-inline"><SettingsTextInput aria-label="Start time" value={startAt} onChange={(event) => setStartAt(event.currentTarget.value)} placeholder="2026-09-09T09:00:00" /><SettingsTextInput aria-label="End time" value={endAt} onChange={(event) => setEndAt(event.currentTarget.value)} placeholder="2026-12-31T18:00:00" /></div></SettingsRow>
          <SettingsRow label="Weekdays / daily times" description="0=Sunday; comma-separated times" layout="stacked"><div className="lightvela-management-inline"><SettingsTextInput aria-label="Weekdays" value={weekdays} onChange={(event) => setWeekdays(event.currentTarget.value)} placeholder="1,2,3,4,5" /><SettingsTextInput aria-label="Daily times" value={dailyTimes} onChange={(event) => setDailyTimes(event.currentTarget.value)} placeholder="09:00,18:00" /></div></SettingsRow>
          {mode === "agent" ? <SettingsRow label="Pin current model" description="Fail closed instead of silently switching behavior after the global model changes."><SettingsSwitch label="Pin current model" checked={pinCurrentModel} onCheckedChange={setPinCurrentModel} /></SettingsRow> : null}
        </SettingsGroup>
        <SettingsActions align="between">{editingId ? <SettingsButton type="button" onClick={resetDraft}>Cancel</SettingsButton> : <span />}<SettingsButton type="button" variant="primary" disabled={pending !== null || !name.trim() || !schedule.trim() || (mode === "agent" ? !prompt.trim() : !scriptContent.trim())} onClick={() => void save()}>{pending === "save" ? "Saving…" : editingId ? "Save changes" : "Create task"}</SettingsButton></SettingsActions>
      </SettingsSection>
      <SettingsSection title="Recent runs" description="The latest persisted Hermes cron outputs, including model-change skips."><SettingsGroup>{runs.map((run) => <SettingsListItem key={run.id} label={run.job_name || run.job_id} description={run.run_at} metadata={`${run.status ?? "unknown"}${run.skip_reason ? ` · ${run.skip_reason}` : ""}`} />)}{pending !== "load" && runs.length === 0 ? <SettingsNotice>No recent runs.</SettingsNotice> : null}</SettingsGroup></SettingsSection>
    </>
  );
}
