
export type HookRunStatus = "running" | "completed" | "failed" | "blocked" | "stopped";
export type HookOutputEntryKind = "warning" | "stop" | "feedback" | "context" | "error";
export type HookStatsEntryKind = "stop" | "feedback" | "error";
export type HookStatsEntryTone = "error" | "warning";

export interface HookOutputEntry {
  readonly kind: HookOutputEntryKind;
  readonly text: string;
}

export interface HookRun {
  readonly id: string;
  readonly eventName: string;
  readonly source: string;
  readonly status: HookRunStatus;
  readonly statusMessage: string | null;
  readonly entries: readonly HookOutputEntry[];
}

export interface HookStatsEntry {
  readonly kind: HookStatsEntryKind;
  readonly text: string;
}

export interface HookStatsRunEntry {
  readonly tone: HookStatsEntryTone;
  readonly text: string;
}

export interface HookStatsRun {
  readonly id: string;
  readonly eventName: string;
  readonly source: string;
  readonly statusMessage: string | null;
  readonly entries: readonly HookStatsRunEntry[];
  readonly count: number;
}

export interface HookStats {
  readonly count: number;
  readonly blockedCount: number;
  readonly blockedMessages: readonly string[];
  readonly blockedSources: readonly string[];
  readonly errorCount: number;
  readonly entries: readonly HookStatsEntry[];
  readonly feedbackMessages: readonly { readonly source: string; readonly text: string }[];
  readonly runs: readonly HookStatsRun[];
}

/** Narrow untrusted protocol values without coercing identity or message data. */
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function observation(value: unknown): { displayId: string; run: HookRun } | null {
  const envelope = object(value);
  if (!envelope) return null;
  const data = object(envelope.run) ?? envelope;
  if (typeof data.id !== "string" || typeof data.eventName !== "string"
    || typeof data.source !== "string"
    || typeof data.status !== "string"
    || !["running", "completed", "failed", "blocked", "stopped"].includes(data.status)) return null;
  const entries: HookOutputEntry[] = [];
  if (Array.isArray(data.entries)) {
    for (const candidate of data.entries) {
      const entry = object(candidate);
      if (entry && typeof entry.text === "string" && typeof entry.kind === "string"
        && ["warning", "stop", "feedback", "context", "error"].includes(entry.kind)) {
        entries.push({ kind: entry.kind as HookOutputEntryKind, text: entry.text });
      }
    }
  }
  return {
    displayId: typeof envelope.id === "string" ? envelope.id : data.id,
    run: {
      id: data.id, eventName: data.eventName, source: data.source,
      status: data.status as HookRunStatus,
      statusMessage: typeof data.statusMessage === "string" ? data.statusMessage.trim() || null : null,
      entries,
    },
  };
}

export function summarizeHookRuns(value: unknown): HookStats | null {
  if (!Array.isArray(value)) return null;
  const observations = value.map(observation).filter(item => item !== null);
  if (observations.length === 0) return null;
  const blockedMessages: string[] = [], blockedSources: string[] = [];
  const entries: HookStatsEntry[] = [];
  const feedbackMessages: { source: string; text: string }[] = [];
  const runs: HookStatsRun[] = [];
  let blockedCount = 0, errorCount = 0, previousDisplayKey: string | null = null;
  for (const { displayId, run } of observations) {
    if (run.status === "blocked") blockedCount++;
    if (run.status === "failed") errorCount++;
    const blockedPrompt = run.eventName === "userPromptSubmit" && run.status === "blocked";
    if (blockedPrompt) blockedSources.push(run.source);
    const details: HookStatsRunEntry[] = [];
    for (const entry of run.entries) {
      if (entry.kind === "context") continue;
      details.push({ tone: entry.kind === "warning" ? "warning" : "error", text: entry.text });
      if (entry.kind !== "warning") entries.push({ kind: entry.kind, text: entry.text });
      if (entry.kind !== "feedback" || !entry.text.trim()) continue;
      if (blockedPrompt) blockedMessages.push(entry.text.trim());
      else if (run.eventName === "stop") feedbackMessages.push({ source: run.source, text: entry.text.trim() });
    }
    // Compare display values only. Counts and identity belong to observations,
    // while this run list is an adjacent visual compression of those facts.
    const key = JSON.stringify([run.eventName, run.source, run.statusMessage, details]);
    const previous = runs.at(-1);
    if (previous && key === previousDisplayKey) {
      runs[runs.length - 1] = { ...previous, count: previous.count + 1 };
    } else {
      runs.push({ id: displayId, eventName: run.eventName, source: run.source,
        statusMessage: run.statusMessage, entries: details, count: 1 });
    }
    previousDisplayKey = key;
  }
  return { count: observations.length, blockedCount, blockedMessages, blockedSources,
    errorCount, entries, feedbackMessages, runs };
}

export function formatHookSource(source: string): "Admin" | "User" | "Project" | "Plugin" | "Session" | "Unknown" {
  switch (source) {
    case "system":
    case "mdm":
    case "cloudRequirements":
    case "cloudManagedConfig":
    case "legacyManagedConfigFile":
    case "legacyManagedConfigMdm": return "Admin";
    case "user": return "User";
    case "project": return "Project";
    case "plugin": return "Plugin";
    case "sessionFlags": return "Session";
    default: return "Unknown";
  }
}

export function formatHookEventName(eventName: string): string {
  const known = ["preToolUse", "permissionRequest", "postToolUse", "preCompact", "postCompact",
    "sessionStart", "sessionEnd", "userPromptSubmit", "subagentStart", "subagentStop", "stop", "interrupt"];
  return known.includes(eventName) ? eventName[0].toUpperCase() + eventName.slice(1) : eventName;
}
