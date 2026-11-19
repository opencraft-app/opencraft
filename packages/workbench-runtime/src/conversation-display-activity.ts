import {
  formatCommandActivitySummary,
  isToolActivityPresentationSuppressed,
  presentToolActivity,
  type TimelineBlock,
  type ToolActivityPresentation,
} from "@opencraft/chat-core";

type Activity = Extract<TimelineBlock, { type: "command-execution" | "tool-call" | "patch" }>;
const text = (value: unknown, limit = 1024): value is string => typeof value === "string" && value.length <= limit;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const icons = [
  "none",
  "terminal",
  "patch",
  "wrench",
  "search",
  "read",
  "files",
  "stop",
  "agent",
  "image",
  "browser",
  "computer",
];
const clip = (value: string | null | undefined) => (value == null ? null : value.slice(0, 1024));

/** Whitelist the display boundary. Even forged stored data cannot restore call,
 * process, approval, raw result, app resource or detail-fetch identifiers. */
export function parseDisplayActivity(value: unknown): Activity | null {
  const b = object(value),
    preview = object(b?.displayPreview),
    p = object(preview?.presentation);
  if (
    !b ||
    !preview ||
    !p ||
    !text(b.id, 256) ||
    !["pending", "running", "complete", "failed", "interrupted"].includes(String(b.status)) ||
    !["running", "completed", "failed", "interrupted"].includes(String(p.state)) ||
    !["groupable", "standalone"].includes(String(p.grouping)) ||
    !icons.includes(String(p.icon)) ||
    !text(p.summary) ||
    !(p.detail === null || text(p.detail)) ||
    !text(p.summaryKey, 512) ||
    typeof p.summaryOnlyInConversationGroup !== "boolean" ||
    !(preview.commandSummary === undefined || text(preview.commandSummary))
  )
    return null;
  const presentation: ToolActivityPresentation = {
    state: p.state as ToolActivityPresentation["state"],
    grouping: p.grouping as ToolActivityPresentation["grouping"],
    icon: p.icon as ToolActivityPresentation["icon"],
    summary: p.summary,
    detail: p.detail,
    summaryKey: p.summaryKey,
    summaryOnlyInConversationGroup: p.summaryOnlyInConversationGroup,
    canExpand: false,
    durationMs:
      p.state !== "running" && typeof p.durationMs === "number" && Number.isFinite(p.durationMs) && p.durationMs >= 0
        ? p.durationMs
        : null,
    continuesLiveActivityBetweenCalls: false,
  };
  const base = {
    id: b.id,
    sourceItemIds: [],
    status: b.status as Activity["status"],
    automaticApprovalReviews: [],
    displayPreview: {
      presentation,
      ...(preview.commandSummary === undefined ? {} : { commandSummary: preview.commandSummary }),
    },
  };
  if (b.type === "command-execution") {
    if (!text(b.command) || !Array.isArray(b.actions) || b.actions.length > 16) return null;
    const actions: Extract<Activity, { type: "command-execution" }>["actions"][number][] = [];
    for (const value of b.actions) {
      const a = object(value);
      if (!a || !text(a.command)) return null;
      if (a.type === "read" && text(a.name) && text(a.path))
        actions.push({ type: "read", command: a.command, name: a.name, path: a.path });
      else if (a.type === "list-files" && (a.path === null || text(a.path)))
        actions.push({ type: "list-files", command: a.command, path: a.path });
      else if (a.type === "search" && (a.path === null || text(a.path)) && (a.query === null || text(a.query)))
        actions.push({ type: "search", command: a.command, path: a.path, query: a.query });
      else if (a.type === "unknown") actions.push({ type: "unknown", command: a.command });
      else return null;
    }
    return {
      ...base,
      type: "command-execution",
      command: b.command,
      actions,
      callId: null,
      cwd: null,
      processId: null,
      startedAtMs: null,
      turnInProgress: false,
      output: null,
      exitCode: null,
      durationMs: presentation.durationMs,
    };
  }
  if (b.type === "patch") {
    if (!text(b.title) || !Array.isArray(b.changes) || b.changes.length > 32) return null;
    const changes = b.changes.map(object);
    if (changes.some((c) => !c || !text(c.path))) return null;
    return {
      ...base,
      type: "patch",
      title: b.title,
      changes: changes.map((c) => ({
        path: c!.path as string,
        kind: "unknown",
        additions: null,
        deletions: null,
        unifiedDiff: null,
        movePath: null,
      })),
    };
  }
  if (
    b.type !== "tool-call" ||
    !["mcp", "dynamic", "web-search", "image-view"].includes(String(b.kind)) ||
    !text(b.name) ||
    ![b.server, b.namespace, b.appName].every((v) => v === null || text(v))
  )
    return null;
  return {
    ...base,
    type: "tool-call",
    kind: b.kind as Extract<Activity, { type: "tool-call" }>["kind"],
    name: b.name,
    server: b.server as string | null,
    namespace: b.namespace as string | null,
    appName: b.appName as string | null,
    sourceKind: b.sourceKind === "browserUse" || b.sourceKind === "computerUse" ? b.sourceKind : null,
    sourceBackend:
      b.sourceBackend === "chrome" || b.sourceBackend === "iab" || b.sourceBackend === "cdp" ? b.sourceBackend : null,
    callId: null,
    input: null,
    output: null,
    errorMessage: null,
    durationMs: null,
    readOnlyHint: null,
    appResourceUri: null,
  };
}

/** Persist only the already-presented label and the bounded semantics needed
 * by the shared group presenter, not executable or output bodies. */
export function projectDisplayActivity(block: TimelineBlock): Activity | null {
  if (block.type !== "command-execution" && block.type !== "tool-call" && block.type !== "patch") return null;
  if (block.displayPreview) return parseDisplayActivity(block);
  if (
    block.type === "tool-call" &&
    (isToolActivityPresentationSuppressed(block) ||
      (block.namespace === "clock" && block.name === "sleep") ||
      (block.kind === "web-search" && !block.input))
  )
    return null;
  const p = presentToolActivity(block);
  const displayPreview = {
    presentation: { ...p, summary: clip(p.summary), detail: clip(p.detail), summaryKey: p.summaryKey.slice(0, 512) },
    ...(block.type === "command-execution"
      ? { commandSummary: clip(formatCommandActivitySummary(block, p.state, { expanded: false, elapsedLabel: null })) }
      : {}),
  };
  const base = { type: block.type, id: block.id, status: block.status, displayPreview };
  if (block.type === "command-execution")
    return parseDisplayActivity({
      ...base,
      command: clip(block.command),
      actions: block.actions
        .slice(0, 16)
        .map((action) =>
          Object.fromEntries(
            Object.entries(action).map(([k, v]) => [k, typeof v === "string" && k !== "type" ? clip(v) : v]),
          ),
        ),
    });
  if (block.type === "patch")
    return parseDisplayActivity({
      ...base,
      title: clip(block.title),
      changes: block.changes.slice(0, 32).map((c) => ({ path: clip(c.path) })),
    });
  return parseDisplayActivity({
    ...base,
    kind: block.kind,
    name: clip(block.name),
    server: clip(block.server),
    namespace: clip(block.namespace),
    appName: clip(block.appName ?? (block.sourceApp?.kind === "displayName" ? block.sourceApp.displayName : null)),
    sourceKind: block.sourceKind,
    sourceBackend: block.sourceBackend,
  });
}

export type ConversationDisplayActivity = NonNullable<ReturnType<typeof parseDisplayActivity>>;
export const MAX_DISPLAY_ACTIVITIES = 64;
