import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeWorkspaceSelection, type ResolvedWorkspaceSelection } from "./ordinary-workspace-selection.js";

/** Internal Host authority only: never construct this from raw RPC metadata.
 * The admission layer authorizes the principal, catalog and creation intent first. */
export interface WorkspaceAuthority { principalId: string; hostId: string }
export interface WorkspaceBinding {
  workspaceId: string;
  intentId: string;
  selectionDigest: string;
  threadId: string | null;
  generation: number;
  phase: "idle" | "creating" | "live" | "releasing" | "uncertain";
  instanceId: string | null;
  privateVolumeId: string | null;
  leaseOwner: string | null;
}
export interface WorkspaceLease { workspaceId: string; generation: number; owner: string }
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const leaseOwner = (workspaceId: string, generation: number) => "ordinary-" + hash(["ordinary-compute-v1", workspaceId, generation]);
const binding = (row: any): WorkspaceBinding => ({ workspaceId: row.workspace_id, intentId: row.intent_id, selectionDigest: row.selection_digest,
  threadId: row.thread_id, generation: row.generation, phase: row.phase, instanceId: row.instance_id, privateVolumeId: row.private_volume_id ?? null, leaseOwner: row.generation > 0 ? leaseOwner(row.workspace_id, row.generation) : null });

/** Durable working-copy identity + fenced compute journal. No filesystem or cloud
 * delete is performed here. Unfinished create/release is deliberately not reset on
 * restart: provider reconciliation must establish absence before another create.
 * This store alone is NOT user authorization or an allocator. */
export class OrdinaryWorkspaceStore {
  private readonly db: DatabaseSync;
  constructor(directory: string, private readonly deploymentId: string) {
    if (!text(deploymentId)) throw Error("Invalid deployment identity");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())) throw Error("Workspace journal directory must be private");
    const path = join(directory, "ordinary-workspaces.sqlite");
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    const file = lstatSync(path);
    if (!file.isFile() || file.mode & 0o077 || (process.getuid && file.uid !== process.getuid())) throw Error("Workspace journal must be private");
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS workspace_journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ordinary_workspaces (
          authority_key TEXT NOT NULL, principal_id TEXT NOT NULL, host_id TEXT NOT NULL, intent_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL UNIQUE, selection_digest TEXT NOT NULL,
          thread_id TEXT, generation INTEGER NOT NULL DEFAULT 0,
          phase TEXT NOT NULL DEFAULT 'idle' CHECK(phase IN ('idle','creating','live','releasing','uncertain')),
          instance_id TEXT, PRIMARY KEY(authority_key,intent_id), UNIQUE(host_id,thread_id));`);
      this.transaction(() => {
        const meta = this.db.prepare("SELECT value FROM workspace_journal_meta WHERE key='deployment'").get() as any;
        if (meta && meta.value !== deploymentId) throw Error("Workspace journal deployment mismatch");
        this.db.prepare("INSERT OR IGNORE INTO workspace_journal_meta VALUES ('deployment',?)").run(deploymentId);
        const version = this.db.prepare("SELECT value FROM workspace_journal_meta WHERE key='schema'").get() as any;
        if (version && !['1', '2', '3', '4'].includes(version.value)) throw Error("Unsupported workspace journal schema");
        this.db.exec(`CREATE TABLE IF NOT EXISTS ordinary_workspace_selections (
          workspace_id TEXT PRIMARY KEY, selection_json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS ordinary_workspace_thread_starts (
            workspace_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
            phase TEXT NOT NULL CHECK(phase IN ('dispatched','confirmed')));`);
        const columns = this.db.prepare("PRAGMA table_info(ordinary_workspaces)").all() as { name: string }[];
        if (!columns.some(column => column.name === "private_volume_id"))
          this.db.exec("ALTER TABLE ordinary_workspaces ADD COLUMN private_volume_id TEXT");
        this.db.prepare("INSERT OR REPLACE INTO workspace_journal_meta VALUES ('schema','4')").run();
      });
    } catch (error) { this.db.close(); throw error; }
  }
  private authority(scope: WorkspaceAuthority) {
    if (!scope || !text(scope.principalId) || !text(scope.hostId)) throw Error("Workspace authority required");
    return hash([this.deploymentId, scope.principalId, scope.hostId]);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** selectionDigest is canonical resolved catalog/repository selection, not a URL,
   * key or client-selected volume. Retrying an intent with another selection fails. */
  admit(scope: WorkspaceAuthority, intentId: string, selectionDigest: string): WorkspaceBinding {
    return this.admitRecord(scope, intentId, selectionDigest);
  }
  /** Called only after catalog/source authorization. Snapshot and identity commit
   * together, before any cloud allocation or shared-base preparation. */
  admitResolved(scope: WorkspaceAuthority, intentId: string, selection: ResolvedWorkspaceSelection): WorkspaceBinding {
    const snapshot = encodeWorkspaceSelection(selection);
    return this.admitRecord(scope, intentId, snapshot.digest, snapshot.json);
  }
  private admitRecord(scope: WorkspaceAuthority, intentId: string, selectionDigest: string, selectionJson?: string): WorkspaceBinding {
    const authority = this.authority(scope);
    if (!text(intentId) || !/^[a-f0-9]{64}$/.test(selectionDigest)) throw Error("Invalid workspace admission");
    const workspaceId = "ws-" + hash(["ordinary-workspace-v1", this.deploymentId, scope.principalId, scope.hostId, intentId]).slice(0, 32);
    return this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO ordinary_workspaces(authority_key,principal_id,host_id,intent_id,workspace_id,selection_digest) VALUES (?,?,?,?,?,?)")
        .run(authority, scope.principalId, scope.hostId, intentId, workspaceId, selectionDigest);
      const row = this.db.prepare("SELECT * FROM ordinary_workspaces WHERE authority_key=? AND intent_id=?").get(authority, intentId) as any;
      if (!row || row.selection_digest !== selectionDigest) throw Error("Workspace admission intent conflict");
      if (selectionJson !== undefined) {
        this.db.prepare("INSERT OR IGNORE INTO ordinary_workspace_selections VALUES (?,?)").run(workspaceId, selectionJson);
        const saved = this.db.prepare("SELECT selection_json FROM ordinary_workspace_selections WHERE workspace_id=?").get(workspaceId) as any;
        if (saved.selection_json !== selectionJson) throw Error("Workspace selection snapshot conflict");
      }
      return binding(row);
    });
  }
  /** Returned data is not permission: recovery must reauthorize the principal and
   * immutable catalog/library generation. Never substitute the latest generation. */
  resolvedSelection(scope: WorkspaceAuthority, workspaceId: string): ResolvedWorkspaceSelection {
    const row = this.read(scope, workspaceId);
    const snapshot = this.db.prepare("SELECT selection_json FROM ordinary_workspace_selections WHERE workspace_id=?").get(workspaceId) as any;
    if (!snapshot) throw Error("Workspace resolved selection unavailable");
    const decoded = encodeWorkspaceSelection(JSON.parse(snapshot.selection_json));
    if (decoded.digest !== row.selectionDigest) throw Error("Workspace selection integrity mismatch");
    return decoded.value;
  }
  attachThread(scope: WorkspaceAuthority, workspaceId: string, threadId: string): WorkspaceBinding {
    if (!text(threadId)) throw Error("Invalid thread identity");
    return this.transaction(() => {
      const row = this.read(scope, workspaceId);
      if (this.threadStartPending(workspaceId)) throw Error("Native thread creation requires reconciliation");
      if (row.threadId && row.threadId !== threadId) throw Error("Workspace already belongs to another thread");
      this.db.prepare("UPDATE ordinary_workspaces SET thread_id=? WHERE authority_key=? AND workspace_id=?").run(threadId, this.authority(scope), workspaceId);
      return this.read(scope, workspaceId);
    });
  }
  private threadStartPending(workspaceId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM ordinary_workspace_thread_starts WHERE workspace_id=? AND phase='dispatched'").get(workspaceId);
  }
  /** Commit before invoking Native thread/start. No reset-on-timeout: even a
   * process crash before sending is conservatively unknown. This is distinct
   * from the daemon's positive, post-response ProvisionalThreads evidence. */
  beginThreadStart(scope: WorkspaceAuthority, lease: WorkspaceLease): void {
    this.transaction(() => {
      const row = this.read(scope, lease.workspaceId);
      if (row.phase !== "live" || row.generation !== lease.generation || row.leaseOwner !== lease.owner || row.threadId)
        throw Error("Invalid Native thread creation lease");
      if (this.threadStartPending(lease.workspaceId)) throw Error("Native thread creation requires reconciliation");
      this.db.prepare("INSERT INTO ordinary_workspace_thread_starts(workspace_id,generation,phase) VALUES (?,?,'dispatched')")
        .run(lease.workspaceId, lease.generation);
    });
  }
  /** Trusted Native response/reconciliation only. Receipt and immutable binding
   * commit atomically. Late receipts are accepted for the same compute generation,
   * including after release; another allocation cannot erase unresolved creation. */
  confirmThreadStarted(scope: WorkspaceAuthority, lease: WorkspaceLease, threadId: string): WorkspaceBinding {
    if (!text(threadId)) throw Error("Invalid thread identity");
    return this.transaction(() => {
      const row = this.read(scope, lease.workspaceId);
      const start = this.db.prepare("SELECT generation,phase FROM ordinary_workspace_thread_starts WHERE workspace_id=?").get(lease.workspaceId);
      if (!start || start.generation !== lease.generation || row.generation !== lease.generation || row.leaseOwner !== lease.owner)
        throw Error("Stale Native thread creation receipt");
      if (row.threadId && row.threadId !== threadId) throw Error("Workspace already belongs to another thread");
      this.db.prepare("UPDATE ordinary_workspaces SET thread_id=? WHERE workspace_id=?").run(threadId, lease.workspaceId);
      this.db.prepare("UPDATE ordinary_workspace_thread_starts SET phase='confirmed' WHERE workspace_id=?").run(lease.workspaceId);
      return this.read(scope, lease.workspaceId);
    });
  }
  /** Private recovery inventory includes idle compute with ambiguous Native
   * creation. Do not derive user authority from this administrative inventory. */
  pendingThreadStarts(hostId: string, afterWorkspaceId = "", limit = 100): { authority: WorkspaceAuthority; binding: WorkspaceBinding }[] {
    if (!text(hostId) || !Number.isInteger(limit) || limit < 1 || limit > 500
      || (afterWorkspaceId !== "" && !/^ws-[a-f0-9]{32}$/.test(afterWorkspaceId))) throw Error("Invalid journal inventory cursor");
    return this.db.prepare(`SELECT w.* FROM ordinary_workspaces w JOIN ordinary_workspace_thread_starts s USING(workspace_id)
      WHERE w.host_id=? AND s.phase='dispatched' AND w.workspace_id>? ORDER BY w.workspace_id LIMIT ?`)
      .all(hostId, afterWorkspaceId, limit).map((row: any) => ({ authority: { principalId: row.principal_id, hostId: row.host_id }, binding: binding(row) }));
  }
  read(scope: WorkspaceAuthority, workspaceId: string): WorkspaceBinding {
    const row = this.db.prepare("SELECT * FROM ordinary_workspaces WHERE authority_key=? AND workspace_id=?").get(this.authority(scope), workspaceId);
    if (!row) throw Error("Workspace binding not found"); return binding(row);
  }
  forThread(scope: WorkspaceAuthority, threadId: string): WorkspaceBinding | null {
    if (!text(threadId)) throw Error("Invalid thread identity");
    const row = this.db.prepare("SELECT * FROM ordinary_workspaces WHERE authority_key=? AND thread_id=?").get(this.authority(scope), threadId);
    return row ? binding(row) : null;
  }
  /** Trusted routing classification only, NOT a grant or a binding lookup.
   * Must include other principals' placements so an unauthorized remote thread
   * can never be misclassified as a local thread. No owner data is returned. */
  hasThread(hostId: string, threadId: string): boolean {
    if (!text(hostId) || !text(threadId)) throw Error("Invalid thread identity");
    return !!this.db.prepare("SELECT 1 FROM ordinary_workspaces WHERE host_id=? AND thread_id=?").get(hostId, threadId);
  }
  beginCreate(scope: WorkspaceAuthority, workspaceId: string): WorkspaceLease {
    return this.transaction(() => {
      const row = this.read(scope, workspaceId);
      if (this.threadStartPending(workspaceId)) throw Error("Native thread creation requires reconciliation");
      if (row.phase !== 'idle') throw Error("Workspace compute requires reconciliation");
      this.db.prepare("UPDATE ordinary_workspaces SET phase='creating',generation=generation+1 WHERE authority_key=? AND workspace_id=?").run(this.authority(scope), workspaceId);
      return { workspaceId, generation: row.generation + 1, owner: leaseOwner(workspaceId, row.generation + 1) };
    });
  }
  /** Cancel only a claim which the trusted allocator proves never reached the
   * provider. This is not remote absence/reconciliation and cannot erase a receipt. */
  cancelUnsubmittedCreate(scope: WorkspaceAuthority, lease: WorkspaceLease) {
    return this.transaction(() => {
      const row = this.read(scope, lease.workspaceId);
      if (row.generation !== lease.generation || row.leaseOwner !== lease.owner || row.phase !== 'creating'
        || row.instanceId !== null || this.threadStartPending(lease.workspaceId)) throw Error('Stale unsubmitted workspace claim');
      this.db.prepare("UPDATE ordinary_workspaces SET phase='idle' WHERE authority_key=? AND workspace_id=?")
        .run(this.authority(scope), lease.workspaceId);
      return this.read(scope, lease.workspaceId);
    });
  }
  private transition(scope: WorkspaceAuthority, lease: WorkspaceLease, from: WorkspaceBinding['phase'][], to: WorkspaceBinding['phase'], instanceId?: string | null) {
    if (!Number.isSafeInteger(lease.generation) || lease.generation < 1) throw Error("Invalid workspace lease generation");
    return this.transaction(() => {
      const row = this.read(scope, lease.workspaceId);
      if (row.generation !== lease.generation || row.leaseOwner !== lease.owner || !from.includes(row.phase)) throw Error("Stale workspace lease transition");
      if (to === 'live' && row.instanceId && row.instanceId !== instanceId) throw Error("Workspace provider receipt conflict");
      this.db.prepare("UPDATE ordinary_workspaces SET phase=?,instance_id=? WHERE authority_key=? AND workspace_id=?").run(to, instanceId === undefined ? row.instanceId : instanceId, this.authority(scope), lease.workspaceId);
      return this.read(scope, lease.workspaceId);
    });
  }
  /** Persist the verified private provider receipt before exposing allocation.
   * The provider's onCreated callback may call this before returning its handle.
   * Repeated callbacks are idempotent, replacement volumes/instances are rejected. */
  recordProviderReceipt(scope: WorkspaceAuthority, lease: WorkspaceLease, receipt: { instanceId: string; privateVolumeId: string }) {
    if (!text(receipt.instanceId) || !text(receipt.privateVolumeId)) throw Error("Invalid workspace provider receipt");
    return this.transaction(() => {
      const row = this.read(scope, lease.workspaceId);
      if (row.generation !== lease.generation || row.leaseOwner !== lease.owner || row.phase !== "creating") throw Error("Stale workspace provider receipt");
      if ((row.privateVolumeId && row.privateVolumeId !== receipt.privateVolumeId) || (row.instanceId && row.instanceId !== receipt.instanceId))
        throw Error("Workspace provider receipt conflict");
      this.db.prepare("UPDATE ordinary_workspaces SET instance_id=?,private_volume_id=? WHERE authority_key=? AND workspace_id=?")
        .run(receipt.instanceId, receipt.privateVolumeId, this.authority(scope), lease.workspaceId);
      return this.read(scope, lease.workspaceId);
    });
  }
  confirmCreated(scope: WorkspaceAuthority, lease: WorkspaceLease, instanceId: string) {
    if (!text(instanceId)) throw Error("Invalid instance identity");
    return this.transition(scope, lease, ['creating'], 'live', instanceId);
  }
  beginRelease(scope: WorkspaceAuthority, lease: WorkspaceLease) { return this.transition(scope, lease, ['live'], 'releasing'); }
  markUncertain(scope: WorkspaceAuthority, lease: WorkspaceLease) { return this.transition(scope, lease, ['creating','live','releasing','uncertain'], 'uncertain'); }
  /** Only the provider reconciler may call after confirmed non-creation/deletion
   * or verified absence of owned live members. Never clear a 409 by assumption. */
  confirmComputeAbsent(scope: WorkspaceAuthority, lease: WorkspaceLease) { return this.transition(scope, lease, ['creating','releasing','uncertain'], 'idle', null); }
  /** Private lifecycle inventory, not a user-facing catalog. Includes unbound
   * creation intents so a crash before thread attachment is still recoverable. */
  pendingForHost(hostId: string, afterWorkspaceId = "", limit = 100): { authority: WorkspaceAuthority; binding: WorkspaceBinding }[] {
    if (!text(hostId) || !Number.isInteger(limit) || limit < 1 || limit > 500
      || (afterWorkspaceId !== "" && !/^ws-[a-f0-9]{32}$/.test(afterWorkspaceId))) throw Error("Invalid journal inventory cursor");
    return this.db.prepare("SELECT * FROM ordinary_workspaces WHERE host_id=? AND phase!='idle' AND workspace_id>? ORDER BY workspace_id LIMIT ?")
      .all(hostId, afterWorkspaceId, limit).map((row: any) => ({ authority: { principalId: row.principal_id, hostId: row.host_id }, binding: binding(row) }));
  }
  /** Read-only placement inventory; idle retained workspaces are still remote. */
  placementPage(hostId: string, afterWorkspaceId = "", limit = 256): {workspaceId: string; hostId: string; threadId: string}[] {
    if (!text(hostId) || !Number.isInteger(limit) || limit < 1 || limit > 500
      || afterWorkspaceId !== "" && !/^ws-[a-f0-9]{32}$/.test(afterWorkspaceId)) throw Error("Invalid placement cursor");
    return this.db.prepare("SELECT workspace_id,host_id,thread_id FROM ordinary_workspaces WHERE host_id=? AND thread_id IS NOT NULL AND workspace_id>? ORDER BY workspace_id LIMIT ?")
      .all(hostId, afterWorkspaceId, limit).map(row => ({workspaceId: String(row.workspace_id), hostId: String(row.host_id), threadId: String(row.thread_id)}));
  }
  close() { this.db.close(); }
}
