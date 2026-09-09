import {
  isTestRunMarkerName,
  type CronEffectiveWindow,
  type CronJob,
} from "./hermes-cron-client";
import type { InstalledSkillLoadState } from "../skills/hermes-skills-client";

/**
 * Directly migrated from mono2's agent-automations-panel.  This module owns
 * cron dependency eligibility; the Workbench editor is only a presentation
 * adapter and must not recreate these rules.
 */

export function wouldCreateCronContextCycle(
  jobs: readonly CronJob[],
  downstreamId: string,
  upstreamId: string,
): boolean {
  if (downstreamId === upstreamId) return true;

  const upstreamsByJob = new Map(jobs.map((job) => [job.id, job.context_from ?? []]));
  const stack = [upstreamId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === downstreamId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(upstreamsByJob.get(id) ?? []));
  }

  return false;
}

export function toCreateCronSkills(selectedSkill: string): string[] | undefined {
  return selectedSkill ? [selectedSkill] : undefined;
}

export function toEditCronSkills(initialSkills: string[], selectedSkill: string): string[] | undefined {
  const initialSelectedSkill = initialSkills[0] ?? "";
  if (selectedSkill === initialSelectedSkill) return undefined;
  return selectedSkill ? [selectedSkill] : [];
}

export type AutomationSkillSelectionIssue = "unavailable" | "unverified";

export function getAutomationSkillSelectionIssue({
  mode,
  initialSkills,
  selectedSkill,
  initialSkillWasAvailable,
  verificationState,
}: {
  mode: "create" | "edit";
  initialSkills: string[];
  selectedSkill: string;
  initialSkillWasAvailable: boolean | null;
  verificationState: InstalledSkillLoadState;
}): AutomationSkillSelectionIssue | null {
  if (!selectedSkill) return null;
  const initialSelectedSkill = initialSkills[0] ?? "";
  const selectionChanged = selectedSkill !== initialSelectedSkill;
  const needsVerification = mode === "create" || selectionChanged || initialSkillWasAvailable === true;
  if (!needsVerification) return null;
  if (verificationState.status !== "ready") return "unverified";
  return verificationState.slugs.includes(selectedSkill) ? null : "unavailable";
}

export function getEligibleCronUpstreams(
  jobs: readonly CronJob[],
  currentJobId: string | null,
  now: number,
): CronJob[] {
  return jobs.filter((job) => {
    if (job.id === currentJobId) return false;
    if (isCronJobPaused(job) || isCronJobUnavailableAsUpstream(job, now)) return false;
    if (isTestRunMarkerName(job.name) || isScenarioTrialJob(job)) return false;
    return currentJobId === null
      || !wouldCreateCronContextCycle(jobs, currentJobId, job.id);
  });
}

export function toCronContextPatch(
  _initial: readonly string[] | null,
  selected: string,
  changed: boolean,
): undefined | string[] {
  if (!changed) return undefined;
  return selected ? [selected] : [];
}

export function isCronJobPaused(job: CronJob): boolean {
  return !isCronJobEnded(job)
    && (!job.enabled || job.state.trim().toLowerCase() === "paused");
}

function isCronJobTerminalState(job: CronJob): boolean {
  return ["completed", "error", "done", "expired", "cancelled", "canceled"]
    .includes(job.state.trim().toLowerCase());
}

function isCronJobRunning(job: CronJob): boolean {
  return job.execution_status?.trim().toLowerCase() === "running";
}

function isCronJobEnded(job: CronJob): boolean {
  return isCronJobTerminalState(job)
    || (!isCronJobRunning(job) && isCronJobExpiredBeyondGrace(job));
}

function isOnceCronJob(job: CronJob): boolean {
  const kind = job.schedule.kind.toLowerCase();
  const display = (job.schedule.display || job.schedule.expr || "").trim();
  return kind === "once" || display.toLowerCase().startsWith("once");
}

function isCronJobExpired(job: CronJob, now = Date.now()): boolean {
  if (!isOnceCronJob(job) || !job.next_run_at) return false;
  const d = parseCronDate(job.next_run_at);
  return !Number.isNaN(d.getTime()) && d.getTime() < now;
}

export function isCronJobUnavailableAsUpstream(job: CronJob, now = Date.now()): boolean {
  return isCronJobExpired(job, now)
    || isCronJobTerminalState(job)
    || getEffectiveWindowStatus(job.effective_window, now) === "ended";
}

function isCronJobExpiredBeyondGrace(job: CronJob): boolean {
  if (!isOnceCronJob(job) || !job.next_run_at) return false;
  const d = parseCronDate(job.next_run_at);
  return !Number.isNaN(d.getTime()) && Date.now() - d.getTime() > 10 * 60 * 1000;
}

function isScenarioTrialJob(job: CronJob): boolean {
  return isOnceCronJob(job) && job.name.startsWith("试跑 - ");
}

export function parseCronDate(value: string): Date {
  const normalized = value
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\.(\d{3})\d+(?=(?:Z|[+-]\d{2}:?\d{2})?$)/, ".$1");
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) {
    return new Date(normalized);
  }

  const localMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ tT]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(normalized);
  if (localMatch) {
    const [, year, month, day, hour = "0", minute = "0", second = "0", ms = "0"] = localMatch;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(ms.padEnd(3, "0")),
    );
  }

  return new Date(normalized);
}

function getEffectiveWindowStatus(
  window: CronEffectiveWindow | null,
  now = Date.now(),
): "always" | "pending" | "active" | "ended" {
  if (!window?.start_at && !window?.end_at && !window?.weekdays?.length) return "always";
  const start = window.start_at ? parseCronDate(window.start_at).getTime() : Number.NaN;
  const end = window.end_at ? parseCronDate(window.end_at).getTime() : Number.NaN;
  if (!Number.isNaN(start) && now < start) return "pending";
  if (!Number.isNaN(end) && now > end) return "ended";
  return "active";
}
