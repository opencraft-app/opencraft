import type { JsonValue } from "../types/domain.js";

export interface ThreadProtocolThread extends Record<string, unknown> {
  cwd?: string | undefined;
  modelProvider?: string | undefined;
  turns?: unknown[] | undefined;
}

export interface ThreadStartParams extends Record<string, unknown> {
  cwd?: string | undefined;
  model?: string | undefined;
  modelProvider?: string | undefined;
  serviceTier?: JsonValue | undefined;
  reasoningEffort?: JsonValue | undefined;
  effort?: JsonValue | undefined;
  approvalPolicy?: JsonValue | undefined;
  approvalsReviewer?: JsonValue | undefined;
  permissions?: JsonValue | undefined;
  sandbox?: JsonValue | undefined;
  sandboxPolicy?: JsonValue | undefined;
}

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: false }
  | {
    type: "workspaceWrite";
    writableRoots: string[];
    networkAccess: false;
    excludeSlashTmp: false;
    excludeTmpdirEnvVar: false;
  }
  | Record<string, JsonValue>;

export interface ThreadStartResult {
  thread: ThreadProtocolThread & { turns: [] };
  model: string;
  modelProvider: string;
  serviceTier: JsonValue | null;
  reasoningEffort: JsonValue | null;
  cwd: string;
  approvalPolicy: JsonValue;
  approvalsReviewer: JsonValue;
  sandbox: SandboxPolicy;
  instructionSources: [];
}

export interface ThreadMetadataUpdateResult {
  thread: ThreadProtocolThread & { turns: [] };
}

// Native Codex deliberately strips history from thread/started. History is
// delivered by the request response and the paginated history RPCs. Replaying
// turns here makes Desktop hydrate the same conversation through two paths and
// can replace an already-hydrated history island.
export function threadStartedProjection<Thread extends ThreadProtocolThread>(
  thread: Thread,
): Thread & { turns: [] } {
  return { ...thread, turns: [] };
}

// Native Codex returns metadata only from thread/metadata/update. Returning
// the manager's live `turns` array makes Desktop hydrate the same Turn a
// second time while its inline-visualization webview is still mounting.
export function threadMetadataUpdateResponse(
  thread: ThreadProtocolThread,
): ThreadMetadataUpdateResult {
  return { thread: threadStartedProjection(thread) };
}

function sandboxPolicy(params: ThreadStartParams, cwd: string): SandboxPolicy {
  const explicit = params.sandboxPolicy;
  if (explicit !== null && typeof explicit === "object" && !Array.isArray(explicit)) {
    return explicit;
  }
  const permission = String(params.permissions ?? "").replace(/^:/, "");
  if (permission === "danger-full-access") return { type: "dangerFullAccess" };
  if (permission === "read-only") return { type: "readOnly", networkAccess: false };
  const mode = params.sandbox;
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
  };
}

// thread/start has a richer response than thread/started. Desktop consumes the
// execution settings immediately (notably sandbox.type), so every engine must
// return this complete native shape even when its runtime is created lazily.
export function threadStartResponse(
  params: ThreadStartParams,
  thread: ThreadProtocolThread,
): ThreadStartResult {
  const cwd = params.cwd ?? thread.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("thread/start requires a non-empty cwd");
  }
  return {
    thread: threadStartedProjection(thread),
    model: params.model ?? "gpt-5.6-sol",
    modelProvider: params.modelProvider ?? thread.modelProvider ?? "openai",
    serviceTier: params.serviceTier ?? null,
    reasoningEffort: params.reasoningEffort ?? params.effort ?? null,
    cwd,
    approvalPolicy: params.approvalPolicy ?? "on-request",
    approvalsReviewer: params.approvalsReviewer ?? "user",
    sandbox: sandboxPolicy(params, cwd),
    instructionSources: [],
  };
}
