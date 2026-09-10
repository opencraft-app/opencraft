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

/**
 * Turn-scoped projection used by Codex's response action row. The extra
 * blocked/feedback fields stay renderer-neutral because they also determine
 * whether a hook-owned user prompt is surfaced by product shells.
 */
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

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hookOutputEntry(value: unknown): HookOutputEntry | null {
  const source = record(value);
  const kind = text(source?.kind);
  const entryText = text(source?.text);
  if (
    entryText === null
    || (kind !== "warning" && kind !== "stop" && kind !== "feedback" && kind !== "context" && kind !== "error")
  ) return null;
  return { kind, text: entryText };
}

function hookRun(value: unknown): HookRun | null {
  const wrapper = record(value);
  const source = record(wrapper?.run) ?? wrapper;
  const id = text(wrapper?.id) ?? text(source?.id);
  const eventName = text(source?.eventName);
  const runSource = text(source?.source);
  const status = text(source?.status);
  if (
    id === null
    || eventName === null
    || runSource === null
    || (status !== "running" && status !== "completed" && status !== "failed" && status !== "blocked" && status !== "stopped")
  ) return null;
  return {
    id,
    eventName,
    source: runSource,
    status,
    statusMessage: text(source?.statusMessage)?.trim() || null,
    entries: Array.isArray(source?.entries)
      ? source.entries.flatMap((entry) => {
        const normalized = hookOutputEntry(entry);
        return normalized === null ? [] : [normalized];
      })
      : [],
  };
}

function equivalentRuns(left: HookStatsRun, right: HookStatsRun): boolean {
  return left.eventName === right.eventName
    && left.source === right.source
    && left.statusMessage === right.statusMessage
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => {
      const candidate = right.entries[index];
      return candidate !== undefined
        && entry.tone === candidate.tone
        && entry.text === candidate.text;
    });
}

/** Source-equivalent reconstruction of Codex's `ga(turn.hookRuns)` reducer. */
export function summarizeHookRuns(value: unknown): HookStats | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalizedRuns = value.flatMap((entry) => {
    const run = hookRun(entry);
    return run === null ? [] : [run];
  });
  if (normalizedRuns.length === 0) return null;

  const entries: HookStatsEntry[] = [];
  const blockedMessages: string[] = [];
  const blockedSources: string[] = [];
  const feedbackMessages: Array<{ source: string; text: string }> = [];
  const runs: HookStatsRun[] = [];
  let blockedCount = 0;
  let errorCount = 0;

  for (const run of normalizedRuns) {
    const runEntries: HookStatsRunEntry[] = [];
    const feedback: string[] = [];
    for (const entry of run.entries) {
      switch (entry.kind) {
        case "error":
        case "feedback":
        case "stop": {
          entries.push({ kind: entry.kind, text: entry.text });
          runEntries.push({ tone: "error", text: entry.text });
          if (entry.kind === "feedback" && entry.text.trim().length > 0) feedback.push(entry.text.trim());
          break;
        }
        case "warning":
          runEntries.push({ tone: "warning", text: entry.text });
          break;
        case "context":
          break;
      }
    }

    if (run.status === "blocked") {
      blockedCount += 1;
      if (run.eventName === "userPromptSubmit") {
        blockedSources.push(run.source);
        blockedMessages.push(...feedback);
      }
    } else if (run.status === "failed") {
      errorCount += 1;
    }
    if (run.eventName === "stop") {
      feedbackMessages.push(...feedback.map((entry) => ({ source: run.source, text: entry })));
    }

    const projected: HookStatsRun = {
      id: run.id,
      eventName: run.eventName,
      source: run.source,
      statusMessage: run.statusMessage,
      entries: runEntries,
      count: 1,
    };
    const previous = runs.at(-1);
    if (previous !== undefined && equivalentRuns(previous, projected)) {
      runs[runs.length - 1] = { ...previous, count: previous.count + 1 };
    } else {
      runs.push(projected);
    }
  }

  return {
    count: normalizedRuns.length,
    blockedCount,
    blockedMessages,
    blockedSources,
    errorCount,
    entries,
    feedbackMessages,
    runs,
  };
}

export function formatHookSource(source: string): "Admin" | "User" | "Project" | "Plugin" | "Session" | "Unknown" {
  if (
    source === "system"
    || source === "mdm"
    || source === "cloudRequirements"
    || source === "cloudManagedConfig"
    || source === "legacyManagedConfigFile"
    || source === "legacyManagedConfigMdm"
  ) return "Admin";
  if (source === "user") return "User";
  if (source === "project") return "Project";
  if (source === "plugin") return "Plugin";
  if (source === "sessionFlags") return "Session";
  return "Unknown";
}

/** Exact English labels used by Codex's detailed Hooks tooltip. */
export function formatHookEventName(eventName: string): string {
  switch (eventName) {
    case "preToolUse": return "PreToolUse";
    case "permissionRequest": return "PermissionRequest";
    case "postToolUse": return "PostToolUse";
    case "preCompact": return "PreCompact";
    case "postCompact": return "PostCompact";
    case "sessionStart": return "SessionStart";
    case "sessionEnd": return "SessionEnd";
    case "userPromptSubmit": return "UserPromptSubmit";
    case "subagentStart": return "SubagentStart";
    case "subagentStop": return "SubagentStop";
    case "stop": return "Stop";
    default: return eventName;
  }
}
