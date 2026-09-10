import type { ToolCallTimelineBlock } from "./timeline";

export interface CreatedThreadToolResult {
  readonly kind: "codex" | "chatgpt";
  readonly threadId: string;
  readonly hostId: string | null;
  readonly pending: boolean;
  readonly title: "Chat created" | "Worktree chat";
}

export interface ThreadHandoffToolResult {
  readonly operationId: string | null;
  readonly status: "queued" | "running" | "success" | "warning" | "error";
  readonly threadTitle: string | null;
  readonly destinationHostDisplayName: string | null;
  readonly destinationHostId: string | null;
  readonly destinationThreadId: string | null;
  readonly destinationCwd: string | null;
  readonly revision: number | null;
  readonly steps: readonly ThreadHandoffStep[];
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean;
  readonly warningMessage: string | null;
  readonly direction: "to-local" | "to-worktree" | "to-host-worktree" | null;
  readonly sourceBranch: string | null;
  readonly localBranch: string | null;
  readonly worktreeBranch: string | null;
}

export type ThreadHandoffStepStatus = "pending" | "running" | "done" | "failed";

export interface ThreadHandoffStep {
  readonly id: string;
  readonly status: ThreadHandoffStepStatus;
}

export interface CodexAppThreadNavigationTarget {
  readonly threadId: string;
  readonly displayName: "Chat";
}

const CODEX_APP_THREAD_TOOL_NAMES = new Set([
  "fork_thread",
  "create_thread",
  "list_threads",
  "read_thread",
  "handoff_thread",
  "get_handoff_status",
  "send_message_to_thread",
  "set_thread_pinned",
  "set_thread_archived",
  "set_thread_title",
]);

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function handoffStepStatus(value: unknown): ThreadHandoffStepStatus | null {
  if (value === "pending" || value === "running" || value === "done" || value === "failed") return value;
  if (value === "complete" || value === "completed" || value === "success") return "done";
  return null;
}

function handoffSteps(value: unknown): readonly ThreadHandoffStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const source = object(entry);
    const id = nonEmptyString(source?.id);
    const status = handoffStepStatus(source?.status);
    return id === null || status === null ? [] : [{ id, status }];
  });
}

function decodeJson(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function dynamicResult(block: ToolCallTimelineBlock): Readonly<Record<string, unknown>> | null {
  if (!Array.isArray(block.output)) return decodeJson(block.output);
  for (const content of block.output) {
    const item = object(content);
    if (item?.type !== "inputText") continue;
    const decoded = decodeJson(item.text);
    if (decoded !== null) return decoded;
  }
  return null;
}

/**
 * Codex gives its own thread tools a semantic renderer. They are not generic
 * expandable JSON calls, even though their AppServer transport carries JSON.
 */
export function isCodexAppThreadTool(block: ToolCallTimelineBlock): boolean {
  return block.kind === "dynamic"
    && block.namespace === "codex_app"
    && CODEX_APP_THREAD_TOOL_NAMES.has(block.name);
}

/** `read_thread` and `send_message_to_thread` are direct navigation affordances. */
export function codexAppThreadNavigationTarget(
  block: ToolCallTimelineBlock,
): CodexAppThreadNavigationTarget | null {
  if (!isCodexAppThreadTool(block)) return null;
  if (block.name !== "read_thread" && block.name !== "send_message_to_thread") return null;
  const input = object(block.input);
  const threadId = nonEmptyString(input?.threadId) ?? nonEmptyString(input?.thread_id);
  return threadId === null ? null : { threadId, displayName: "Chat" };
}

/**
 * Parses the native `codex_app.create_thread` result card without exposing
 * AppServer's JSON/text transport envelope to either renderer.
 */
export function createdThreadToolResult(block: ToolCallTimelineBlock): CreatedThreadToolResult | null {
  if (block.kind !== "dynamic" || block.namespace !== "codex_app" || block.name !== "create_thread") return null;
  if (block.status !== "complete") return null;
  const result = dynamicResult(block);
  if (result === null) return null;
  const threadId = nonEmptyString(result.threadId);
  const clientThreadId = nonEmptyString(result.clientThreadId);
  const identity = threadId ?? clientThreadId;
  if (identity === null) return null;
  const kind = result.kind === "chatgpt" ? "chatgpt" : "codex";
  const pending = threadId === null && clientThreadId !== null;
  return {
    kind,
    threadId: identity,
    hostId: nonEmptyString(result.hostId),
    pending,
    title: kind === "codex" && pending ? "Worktree chat" : "Chat created",
  };
}

export function threadHandoffToolResult(block: ToolCallTimelineBlock): ThreadHandoffToolResult | null {
  if (block.kind !== "dynamic" || block.namespace !== "codex_app") return null;
  if (block.name !== "handoff_thread" && block.name !== "get_handoff_status") return null;
  const result = dynamicResult(block);
  if (result === null) return null;
  const status = result.status;
  if (status !== "queued" && status !== "running" && status !== "success" && status !== "warning" && status !== "error") return null;
  return {
    operationId: nonEmptyString(result.operationId),
    status,
    threadTitle: nonEmptyString(result.threadTitle),
    destinationHostDisplayName: nonEmptyString(result.destinationHostDisplayName),
    destinationHostId: nonEmptyString(result.destinationHostId),
    destinationThreadId: nonEmptyString(result.destinationThreadId),
    destinationCwd: nonEmptyString(result.destinationCwd),
    revision: finiteNumber(result.revision),
    steps: handoffSteps(result.steps),
    errorCode: nonEmptyString(result.errorCode),
    errorMessage: nonEmptyString(result.errorMessage),
    retryable: result.retryable === true,
    warningMessage: nonEmptyString(result.warningMessage),
    direction: result.direction === "to-local" || result.direction === "to-worktree" || result.direction === "to-host-worktree" ? result.direction : null,
    sourceBranch: nonEmptyString(result.sourceBranch),
    localBranch: nonEmptyString(result.localBranch),
    worktreeBranch: nonEmptyString(result.worktreeBranch),
  };
}

/** Recovered handoff progress rule, including the synthetic rollback step. */
export function visibleThreadHandoffSteps(result: ThreadHandoffToolResult): readonly ThreadHandoffStep[] {
  const failedIndex = result.steps.findIndex((step) => step.status === "failed");
  if (failedIndex !== -1) {
    const throughFailure = result.steps.slice(0, failedIndex + 1);
    return failedIndex === result.steps.length - 1
      ? throughFailure
      : [...throughFailure, { id: "rolling-back-changes", status: "running" }];
  }
  if (result.steps.some((step) => step.status === "running")) return result.steps;
  const pendingIndex = result.steps.findIndex((step) => step.status === "pending");
  if (pendingIndex === -1) return result.steps;
  return result.steps.map((step, index) => index === pendingIndex ? { ...step, status: "running" } : step);
}

export function formatThreadHandoffStepLabel(
  stepId: string,
  result: Pick<ThreadHandoffToolResult, "direction" | "localBranch" | "sourceBranch" | "worktreeBranch">,
): string {
  switch (stepId) {
    case "rolling-back-changes": return "Rolling back changes";
    case "prepare-host-transfer": return "Preparing files for transfer";
    case "transfer-host-artifacts": return "Copying files to the destination host";
    case "create-new-worktree": return "Creating a new worktree";
    case "reuse-existing-worktree": return "Reusing the existing worktree";
    case "stash-source-changes": return "Stashing uncommitted changes";
    case "checkout-local-branch": return `Checking out ${result.localBranch ?? result.sourceBranch ?? "branch"} locally`;
    case "stash-target-worktree-changes": return "Stashing worktree changes";
    case "checkout-worktree-branch": return `Checking out ${result.worktreeBranch ?? result.sourceBranch ?? "branch"} in worktree`;
    case "detach-worktree-branch": return "Detaching branch from worktree";
    case "apply-changes-to-worktree": return "Applying uncommitted changes to worktree";
    case "apply-changes-to-local": return "Applying uncommitted changes locally";
    case "switching-thread":
      return result.direction === "to-worktree" ? "Moving chat to worktree"
        : result.direction === "to-host-worktree" ? "Moving chat to the destination worktree"
        : "Moving chat to local";
    default:
      return stepId.replace(/[-_]+/gu, " ").replace(/^./u, (character) => character.toLocaleUpperCase());
  }
}
