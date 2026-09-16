import { Service } from "@deepseek-ai/cordis";
import { threadStartedProjection } from "./thread-protocol.ts";
import { uuidV7 } from "./thread-identity.ts";

export const MAIN_WORKSPACE_VIEW = "main";
export const LOGICAL_WORKSPACE_ROOT = "/workspace";
export const LOGICAL_PROJECTS_ROOT = `${LOGICAL_WORKSPACE_ROOT}/projects`;
export const WORKSPACE_VIEW_ACTIVE = "active";
export const WORKSPACE_VIEW_DESTROYED = "destroyed";

export function workspaceViewState(record) {
  if (!record) return WORKSPACE_VIEW_ACTIVE;
  return record.state ?? (record.deleted ? WORKSPACE_VIEW_DESTROYED : WORKSPACE_VIEW_ACTIVE);
}

// In workspace v2 every durable ordinary Thread owns a WorkspaceRef.  The
// legacy `main` view is only an import source, never a shared runtime/lease
// identity.  Ephemeral side chats are the sole exception and retain their
// explicit shared source view.
export function runtimeViewId(v2, threadId, record = null) {
  if (record?.kind === "shared") return record.viewId;
  if (v2) return String(threadId);
  return record?.viewId ?? MAIN_WORKSPACE_VIEW;
}

function normalize(path) {
  const parts = [];
  for (const part of String(path || "/workspace").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

// Desktop can retain a cwd from an older catalog projection after HyperNode
// switches to the stable public namespace. Treat the embedded view segment as
// a stale alias only: the caller's active thread remains the authority that
// selects the actual main/fork storage view.
function stripLegacyViewSegment(path) {
  const match = path.match(/^\/workspace\/@(?:main|fork-[^/]+)(\/.*)?$/);
  return match ? `${LOGICAL_WORKSPACE_ROOT}${match[1] ?? ""}` : path;
}

export function viewSegment(viewId) {
  return viewId === MAIN_WORKSPACE_VIEW ? "@main" : `@fork-${viewId.replace(/^fork-/, "")}`;
}

export function viewRoot(viewId) {
  return LOGICAL_WORKSPACE_ROOT;
}

export function projectsRoot(viewId) {
  return LOGICAL_PROJECTS_ROOT;
}

export function storageViewRoot(viewId) {
  return `${LOGICAL_WORKSPACE_ROOT}/${viewSegment(viewId)}`;
}

export function storagePathForView(path, viewId = MAIN_WORKSPACE_VIEW) {
  const value = stripLegacyViewSegment(normalize(path));
  if (value === `${LOGICAL_WORKSPACE_ROOT}/.hypernode` ||
      value.startsWith(`${LOGICAL_WORKSPACE_ROOT}/.hypernode/`)) return value;
  if (value === `${LOGICAL_WORKSPACE_ROOT}/.codex` ||
      value.startsWith(`${LOGICAL_WORKSPACE_ROOT}/.codex/`)) return value;
  if (value === LOGICAL_WORKSPACE_ROOT) return storageViewRoot(viewId);
  if (/^\/workspace\/@(?:main(?:\/|$|-)|fork-)/.test(value)) {
    throw new Error(`physical workspace view paths are not part of the public namespace: ${value}`);
  }
  return `${storageViewRoot(viewId)}${value.slice(LOGICAL_WORKSPACE_ROOT.length)}`;
}

export function logicalPathForView(path, viewId = MAIN_WORKSPACE_VIEW) {
  // Protocol projection visits every string, not only paths. Preserve method
  // names, status values, command output, and identifiers verbatim.
  if (typeof path !== "string" || !path.startsWith("/")) return path;
  return stripLegacyViewSegment(normalize(path));
}

export function workspacePathBelongsToView(path, viewId) {
  const normalized = normalize(path);
  if (normalized !== LOGICAL_WORKSPACE_ROOT && !normalized.startsWith(`${LOGICAL_WORKSPACE_ROOT}/`)) return false;
  return !/^\/workspace\/@(?:main(?:\/|$|-)|fork-)/.test(normalized);
}

export function canonicalWorkspaceCwd(cwd, viewId = MAIN_WORKSPACE_VIEW) {
  const value = normalize(cwd || "/workspace");
  if (value === LOGICAL_WORKSPACE_ROOT) return LOGICAL_PROJECTS_ROOT;
  const legacy = value.match(/^\/workspace\/@(?:main|fork-[^/]+)(\/.*)?$/);
  if (legacy) {
    const suffix = legacy[1] ?? "";
    return suffix === "/projects" || suffix.startsWith("/projects/")
      ? `${LOGICAL_WORKSPACE_ROOT}${suffix}`
      : `${LOGICAL_PROJECTS_ROOT}${suffix}`;
  }
  if (value === LOGICAL_PROJECTS_ROOT || value.startsWith(`${LOGICAL_PROJECTS_ROOT}/`)) return value;
  if (value.startsWith(`${LOGICAL_WORKSPACE_ROOT}/.`)) return value;
  if (value.startsWith(`${LOGICAL_WORKSPACE_ROOT}/`)) {
    return `${LOGICAL_PROJECTS_ROOT}/${value.slice(`${LOGICAL_WORKSPACE_ROOT}/`.length)}`;
  }
  return value;
}

export function rewriteWorkspaceView(path, sourceViewId, destinationViewId) {
  return canonicalWorkspaceCwd(path, sourceViewId);
}

export class WorkspaceViewService extends Service {
  constructor(ctx) {
    super(ctx, "workspaceView");
    this.enabled = ctx.workspaceFilesystem.enabled;
    this.v2 = this.enabled;
    this.records = new Map();
    this.leaseAliases = new Map();
    this.load();
    this.reconcileInterruptedForks();
    ctx.effect(() => ctx.appServer.register("hypernode/workspace/status", () => ({
      runtime: ctx.workspaceFilesystem.status(),
      views: [...this.records.values()],
    })));
    ctx.effect(() => ctx.appServer.register("thread/fork", (params, connection) => this.fork(params, connection)));
  }

  load() {
    const encoded = policyStore.get("workspaceViews", "node");
    if (encoded == null) return;
    const snapshot = JSON.parse(encoded);
    if (snapshot.version !== 1 || !Array.isArray(snapshot.records)) {
      throw new Error("unsupported workspace view catalog");
    }
    for (const record of snapshot.records) {
      // Version 1 used a boolean `deleted`. Preserve wire/storage
      // compatibility while making the lifecycle state explicit.
      record.state = workspaceViewState(record);
      this.records.set(record.threadId, record);
    }
  }

  persist() {
    policyStore.set("workspaceViews", "node", JSON.stringify({
      version: 1,
      records: [...this.records.values()],
    }));
  }

  reconcileInterruptedForks() {
    let recordsChanged = false;
    for (const operation of this.ctx.workspaceOperationJournal.pending("threadFork")) {
      // ThreadManager.create() invokes workspace listeners before it returns.
      // A process may therefore die after a workspace exists but before the
      // journal advances beyond `prepared`.  The persisted target Thread is
      // additional evidence that cleanup must include the workspace.
      const targetThreadExists = this.ctx.threadManager.find(operation.targetThreadId) != null;
      const canHaveWorkspace = operation.state !== "prepared" || targetThreadExists;
      try {
        if (canHaveWorkspace && operation.targetViewId !== operation.sourceViewId && this.enabled) {
          try {
            globalThis.hostWorkspaces.deleteThread(operation.targetThreadId);
          } catch (error) {
            if (!/not found|no such|unknown/i.test(String(error?.message ?? error))) throw error;
          }
        }
        this.ctx.canonicalTimeline.delete(operation.targetThreadId);
        if (this.ctx.threadManager.find(operation.targetThreadId)) {
          this.ctx.threadManager.forget(operation.targetThreadId);
        }
        if (this.records.delete(operation.targetThreadId)) recordsChanged = true;
        this.ctx.workspaceOperationJournal.transition(operation.operationId, "rolledBack", {
          error: "recovered incomplete fork after policy restart",
        });
      } catch (error) {
        this.ctx.workspaceOperationJournal.transition(operation.operationId, "recoveryFailed", { error });
        console.error(
          `[workspace-view] unable to reconcile fork operation=${operation.operationId}: ` +
          `${error?.message ?? error}`,
        );
      }
    }
    if (recordsChanged) this.persist();
  }

  prepareStartParams(params = {}) {
    if (!this.enabled) return params;
    return { ...params, cwd: canonicalWorkspaceCwd(params.cwd, MAIN_WORKSPACE_VIEW) };
  }

  prepareResumeCwd(threadId, cwd) {
    if (!this.enabled || cwd == null) return cwd;
    return canonicalWorkspaceCwd(cwd, this.viewIdForThread(threadId));
  }

  bindMain(thread) {
    if (!this.enabled || !thread?.id || !thread.cwd?.startsWith("/workspace")) return;
    thread.cwd = canonicalWorkspaceCwd(thread.cwd, MAIN_WORKSPACE_VIEW);
    this.records.set(thread.id, {
      threadId: thread.id,
      viewId: this.v2 ? thread.id : MAIN_WORKSPACE_VIEW,
      kind: this.v2 ? "workspace" : "main",
      sourceThreadId: null,
      deleted: false,
      state: WORKSPACE_VIEW_ACTIVE,
      createdAtMs: Date.now(),
    });
    this.persist();
  }

  recordFor(threadId) {
    return this.records.get(threadId) ?? null;
  }

  viewIdForThread(threadId) {
    return runtimeViewId(this.v2, threadId, this.records.get(threadId));
  }

  stateForThread(threadId) {
    return workspaceViewState(this.recordFor(threadId));
  }

  assertRuntimeAvailable(threadId) {
    const record = this.recordFor(threadId);
    if (workspaceViewState(record) !== WORKSPACE_VIEW_DESTROYED) return;
    const error = new Error("workspace view has been destroyed; fork the archived conversation to continue");
    error.code = -32071;
    error.data = {
      kind: "workspaceViewDestroyed",
      threadId,
      viewId: record.viewId,
      destroyedAtMs: record.destroyedAtMs ?? record.deletedAtMs ?? null,
    };
    throw error;
  }

  projectsRoot(viewId = MAIN_WORKSPACE_VIEW) {
    return projectsRoot(viewId);
  }

  assertWritePath(threadId, path) {
    if (!this.enabled) return;
    const record = this.recordFor(threadId);
    const thread = this.ctx.threadManager.find(threadId);
    if (!record && !thread?.cwd?.startsWith("/workspace/")) {
      const error = new Error("active thread does not own a workspace view");
      error.code = -32064;
      error.data = { kind: "workspaceViewNotOwned", threadId, path };
      throw error;
    }
    const normalized = normalize(path);
    if (workspacePathBelongsToView(normalized, record?.viewId ?? MAIN_WORKSPACE_VIEW)) return;
    const viewId = record?.viewId ?? MAIN_WORKSPACE_VIEW;
    const error = new Error(`workspace path is outside the active logical view ${viewId}`);
    error.code = -32065;
    error.data = { kind: "workspaceViewMismatch", threadId, viewId, path: normalized };
    throw error;
  }

  leaseKey(threadId) {
    if (!this.enabled) return `thread:${threadId}`;
    const alias = this.leaseAliases.get(threadId);
    if (alias) return `workspace:${alias}`;
    const record = this.recordFor(threadId);
    if (record) return `workspace:${runtimeViewId(this.v2, threadId, record)}`;
    const thread = this.ctx.threadManager.find(threadId);
    if (thread?.cwd?.startsWith("/workspace/")) {
      return `workspace:${this.v2 ? threadId : MAIN_WORKSPACE_VIEW}`;
    }
    return `thread:${threadId}`;
  }

  bindLeaseAlias(threadId, viewId = MAIN_WORKSPACE_VIEW) {
    if (this.enabled) this.leaseAliases.set(threadId, viewId);
  }

  unbindLeaseAlias(threadId) {
    this.leaseAliases.delete(threadId);
  }

  fork(params, connection, options = {}) {
    const forkStartedAt = Date.now();
    const source = this.ctx.threadManager.get(params.threadId);
    if (this.ctx.threadManager.isSystem(source.id)) throw new Error("system threads cannot be forked");
    const sourceRecord = this.recordFor(source.id);
    const sourceViewId = runtimeViewId(this.v2, source.id, sourceRecord);
    const forkId = uuidV7();
    const sharesSourceView = params.ephemeral === true;
    const targetViewId = sharesSourceView ? sourceViewId : forkId;
    const operation = this.ctx.workspaceOperationJournal.begin({
      operationKind: "threadFork",
      sourceThreadId: source.id,
      targetThreadId: forkId,
      sourceViewId,
      targetViewId,
      details: { ephemeral: sharesSourceView, lastTurnId: params.lastTurnId ?? null },
    });
    let fork;
    let workspacePreparedAt;
    try {
      fork = this.ctx.threadManager.create({
        ...params,
        cwd: source.cwd,
        projectId: source.projectId,
        modelProvider: params.modelProvider ?? source.modelProvider,
        threadSource: params.threadSource ?? source.threadSource,
      }, {
        id: forkId,
        name: source.name,
        preview: source.preview,
      }, {
        ownerPrincipalId: this.ctx.threadManager.ownerOf(source.id) ?? this.ctx.principal.current().id,
        visibility: "nodeShared",
        kind: this.ctx.threadManager.metadataFor(source.id)?.kind ?? "conversation",
        actor: connection?.identity,
        workspaceSourceThreadId: params.ephemeral === true ? null : source.id,
      });
      this.ctx.workspaceOperationJournal.transition(operation.operationId, "threadCreated");
      workspacePreparedAt = Date.now();
    } catch (error) {
      this.ctx.workspaceOperationJournal.transition(operation.operationId, "rolledBack", { error });
      throw error;
    }
    this.ctx.threadTitle.inherit(source.id, fork.id, { actor: connection?.identity });
    const viewId = targetViewId;
    try {
      this.ctx.workspaceOperationJournal.transition(operation.operationId, "workspacePrepared");
      fork.cwd = this.enabled
        ? canonicalWorkspaceCwd(params.cwd ?? source.cwd, sourceViewId)
        : (params.cwd ?? source.cwd);
      fork.forkedFromId = source.id;
      fork.sessionId = source.sessionId;
      this.ctx.canonicalTimeline.fork(source.id, fork.id, {
        lastTurnId: params.lastTurnId ?? null,
      });
      const timelinePreparedAt = Date.now();
      this.ctx.workspaceOperationJournal.transition(operation.operationId, "timelinePrepared");
      fork.turns = this.ctx.canonicalTimeline.turns(fork.id);
      fork.projectId = source.projectId;
      this.records.set(fork.id, {
        threadId: fork.id,
        viewId: this.enabled ? viewId : sourceViewId,
        kind: this.enabled && !sharesSourceView ? "fork" : "shared",
        sourceThreadId: source.id,
        deleted: false,
        state: WORKSPACE_VIEW_ACTIVE,
        createdAtMs: Date.now(),
      });
      this.ctx.threadManager.changed(fork.id);
      this.ctx.threadProjectBinding.capture(
        fork,
        { projectId: source.projectId },
        connection,
        { forceNotify: true },
      );
      this.persist();
      this.ctx.workspaceOperationJournal.transition(operation.operationId, "committed");
      console.info(
        `[workspace-fork] timing source=${source.id} target=${fork.id} ` +
        `workspaceMs=${workspacePreparedAt - forkStartedAt} ` +
        `timelineMs=${timelinePreparedAt - workspacePreparedAt} ` +
        `commitMs=${Date.now() - timelinePreparedAt} totalMs=${Date.now() - forkStartedAt}`,
      );
    } catch (error) {
      if (this.enabled && !sharesSourceView) {
        try { globalThis.hostWorkspaces.deleteThread(fork.id); } catch {}
      }
      try { this.ctx.canonicalTimeline.delete(fork.id); } catch {}
      this.ctx.threadManager.forget(fork.id);
      this.ctx.workspaceOperationJournal.transition(operation.operationId, "rolledBack", { error });
      throw error;
    }
    if (options.notify !== false) {
      this.ctx.appServer.notifyAfter(connection, "thread/started", {
        thread: threadStartedProjection(fork),
      });
    }
    return {
      thread: fork,
      model: params.model ?? "gpt-5.6-sol",
      modelProvider: params.modelProvider ?? fork.modelProvider,
      serviceTier: params.serviceTier ?? null,
      cwd: fork.cwd,
      instructionSources: [],
      approvalPolicy: params.approvalPolicy ?? "on-request",
      approvalsReviewer: params.approvalsReviewer ?? "user",
      sandbox: { type: "workspaceWrite", writableRoots: [fork.cwd], networkAccess: false },
      reasoningEffort: null,
    };
  }

  archive(thread) {
    let record = this.recordFor(thread.id);
    if (this.v2 && !record) {
      record = {
        threadId: thread.id,
        viewId: thread.id,
        kind: "workspace",
        sourceThreadId: thread.forkedFromId ?? null,
        deleted: false,
        state: WORKSPACE_VIEW_ACTIVE,
        createdAtMs: Date.now(),
      };
      this.records.set(thread.id, record);
    }
    if (!record || record.deleted) return;
    record.deleted = true;
    record.state = WORKSPACE_VIEW_DESTROYED;
    record.deletedAtMs = Date.now();
    record.destroyedAtMs = record.deletedAtMs;
    this.persist();
  }

  discardFork(threadId) {
    const thread = this.ctx.threadManager.find(threadId);
    const record = this.recordFor(threadId);
    if (record?.kind === "fork" && !record.deleted && this.enabled) {
      globalThis.hostWorkspaces.deleteThread(threadId);
    }
    this.records.delete(threadId);
    this.persist();
    this.ctx.canonicalTimeline.delete(threadId);
    if (thread) this.ctx.threadManager.forget(threadId);
  }

  assertRestorable(threadId) {
    this.assertRuntimeAvailable(threadId);
  }
}

WorkspaceViewService.inject = [
  "appServer", "canonicalTimeline", "principal", "threadManager", "threadProjectBinding", "threadTitle",
  "workspaceFilesystem", "workspaceOperationJournal",
];
