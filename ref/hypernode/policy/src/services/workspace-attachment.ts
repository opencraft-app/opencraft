import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.js";
import type {
  WorkspaceAttachmentHandle,
  WorkspaceAttachmentInput,
  WorkspaceAttachmentPort,
  WorkspaceAttachmentSnapshot,
  WorkspaceEndpoint,
  WorkspaceFilesystemPort,
  WorkspacePrincipal,
  WorkspaceDriverPort,
} from "../types/workspace.js";

interface AttachmentTransport {
  detach(reason?: string): void;
}

interface AttachmentRecord {
  id: string;
  key: string;
  threadId: string;
  engineId: string;
  viewId: string;
  cwd: string;
  filesystem: WorkspaceFilesystemPort;
  principal: WorkspacePrincipal | string | null;
  references: number;
  attachedAtMs: number;
  lastAttachedAtMs: number;
  detached: boolean;
  detachedAtMs?: number;
  detachReason?: string;
  transport: AttachmentTransport | null;
  endpoint: WorkspaceEndpoint | null;
  capabilityId?: string;
  handle: WorkspaceAttachmentHandle | null;
}

function attachmentKey(threadId: unknown, engineId: unknown): string {
  return `${String(threadId)}\0${String(engineId)}`;
}

function principalIdentity(principal: WorkspacePrincipal | string | null): Required<WorkspacePrincipal> {
  if (principal !== null && typeof principal === "object") {
    const id = String(principal.id ?? "");
    return { id, username: String(principal.username ?? id) };
  }
  const id = String(principal ?? "");
  return { id, username: id };
}

/**
 * Owns the orthogonal Engine <-> Workspace relationship.
 *
 * An attachment is a capability lease, not an engine process and not a
 * filesystem.  Transports (SSH first) may be pooled underneath it without
 * changing Thread or Turn identity.
 */
export class WorkspaceAttachmentService extends Service implements WorkspaceAttachmentPort {
  static inject = ["workspaceDriver"] satisfies Inject<Pick<HypernodeServices, "workspaceDriver">>;

  readonly attachments = new Map<string, AttachmentRecord>();
  readonly driver: WorkspaceDriverPort;
  sequence = 0;

  constructor(ctx: HypernodeContext<"workspaceDriver">) {
    super(ctx, "workspaceAttachment");
    this.driver = ctx.workspaceDriver;
    ctx.effect(() => () => {
      for (const record of [...this.attachments.values()]) this.detachRecord(record, "serviceDisposed");
    });
  }

  attach({
    threadId,
    engineId,
    viewId = "main",
    cwd,
    filesystem,
    principal = null,
  }: WorkspaceAttachmentInput): WorkspaceAttachmentHandle {
    if (!threadId || !engineId) throw new Error("workspace attachment requires threadId and engineId");
    if (!filesystem?.owns?.(cwd)) {
      throw new Error(`workspace attachment cwd is not owned by the selected filesystem: ${cwd}`);
    }
    const key = attachmentKey(threadId, engineId);
    const existing = this.attachments.get(key);
    if (existing) {
      if (existing.viewId !== viewId || existing.cwd !== cwd || existing.filesystem !== filesystem) {
        throw new Error("engine is already attached to a different workspace view");
      }
      existing.references += 1;
      existing.lastAttachedAtMs = Date.now();
      if (!existing.handle) throw new Error("workspace attachment record has no handle");
      return existing.handle;
    }
    const record: AttachmentRecord = {
      id: `workspace-attachment-${++this.sequence}`,
      key,
      threadId: String(threadId),
      engineId: String(engineId),
      viewId: String(viewId),
      cwd: String(cwd),
      filesystem,
      principal,
      references: 1,
      attachedAtMs: Date.now(),
      lastAttachedAtMs: Date.now(),
      detached: false,
      transport: null,
      endpoint: null,
      handle: null,
    };
    if (filesystem?.mount === "/workspace") {
      if (!this.driver.enabled) throw new Error("workspace driver is unavailable");
      this.driver.createWorkspace(record.threadId);
      const identity = principalIdentity(principal);
      const attached = this.driver.attachWorkspace(
        record.threadId,
        identity,
        "readWrite",
      );
      record.endpoint = attached.endpoint;
      record.capabilityId = attached.id;
      record.transport = {
        detach: () => this.driver.detachWorkspace(attached.id),
      };
    }
    const handle: WorkspaceAttachmentHandle = Object.freeze({
      id: record.id,
      threadId: record.threadId,
      engineId: record.engineId,
      viewId: record.viewId,
      cwd: record.cwd,
      endpoint: record.endpoint ? Object.freeze({ ...record.endpoint }) : null,
      capabilityId: record.capabilityId ?? null,
      detach: (reason = "released") => this.detachRecord(record, reason),
    });
    record.handle = handle;
    this.attachments.set(key, record);
    return handle;
  }

  detach(handle: WorkspaceAttachmentHandle, reason = "released"): boolean {
    const record = [...this.attachments.values()].find((entry) => entry.handle === handle);
    return record ? this.detachRecord(record, reason) : false;
  }

  private detachRecord(record: AttachmentRecord, reason = "released"): boolean {
    if (!record || record.detached) return false;
    record.references -= 1;
    if (record.references > 0) return false;
    record.detached = true;
    record.detachedAtMs = Date.now();
    record.detachReason = reason;
    try { record.transport?.detach?.(reason); } catch {}
    this.attachments.delete(record.key);
    return true;
  }

  find(threadId: unknown, engineId: unknown): WorkspaceAttachmentHandle | null {
    return this.attachments.get(attachmentKey(threadId, engineId))?.handle ?? null;
  }

  snapshot(): WorkspaceAttachmentSnapshot[] {
    return [...this.attachments.values()].map((record) => ({
      id: record.id,
      threadId: record.threadId,
      engineId: record.engineId,
      viewId: record.viewId,
      cwd: record.cwd,
      endpoint: record.endpoint ? { ...record.endpoint } : null,
      references: record.references,
      attachedAtMs: record.attachedAtMs,
    }));
  }
}
