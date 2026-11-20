import { browserMetadataKeys } from '@opencraft/workbench-runtime/browser-metadata-identity';
import { ResourceDirectoryReconciler } from '@opencraft/workbench-runtime/resource-directory-reconciler';
import { readCommittedMetadata, flushMetadataKey, observeCommittedMetadata, type ReadyAccountMetadataStorage } from './account-metadata-storage';
import { serverStorageKey } from './server-context';

import { parseResourceDirectorySignals } from '@opencraft/workbench-runtime/resource-directory-signals';
const key = serverStorageKey(browserMetadataKeys.resourceSignals);
const decode = (value: string | null) => parseResourceDirectorySignals(JSON.parse(value ?? '[]'));
export interface ResourceSyncStatus {
  readonly pending: boolean;
  readonly lastSuccessAt: number | null;
  readonly failed: boolean;
}
/** Shared account-scoped broadcast/anti-entropy channel. Signal tokens contain
 * no resource identity, authority, output, draft, focus or layout state. A lost
 * broadcast is repaired by the digest and by authoritative periodic refresh. */
export class WorkbenchResourceSync {
  private readonly handlers = new Map<string, Set<() => Promise<void>>>();
  private readonly reads = new ResourceDirectoryReconciler();
  private readonly releases: Array<() => void> = [];
  private observed = new Map<string, string>();
  private disposed = false;
  private readonly statuses = new Map<string, ResourceSyncStatus>();
  getStatus(kind: string): ResourceSyncStatus | undefined { return this.statuses.get(kind); }
  constructor(private readonly storage: ReadyAccountMetadataStorage) {
    this.releases.push(observeCommittedMetadata(storage, 'resourceSignals', () => this.changed()));
    if (storage.onReconciled) this.releases.push(storage.onReconciled(() => this.refresh()));
    void storage.whenReady().then(() => { if (!this.disposed) { this.changed(); this.refresh(); } }, () => {});
  }
  /** Each owner refreshes its authorized directory across all observed Hosts.
   * Host IDs in hints are not an authority or a filtering contract. */
  register(kind: string, refresh: () => Promise<void>): () => void {
    if (this.disposed) return () => {};
    const group = this.handlers.get(kind) ?? new Set<() => Promise<void>>();
    group.add(refresh);
    this.handlers.set(kind, group);
    this.read(kind);
    return () => {
      group.delete(refresh);
      if (!group.size && this.handlers.get(kind) === group) {
        this.handlers.delete(kind);
        this.statuses.delete(kind);
      }
    };
  }
  private read(kind: string) {
    if (this.disposed || !this.handlers.has(kind)) return;
    this.statuses.set(kind, { pending: true, lastSuccessAt: this.statuses.get(kind)?.lastSuccessAt ?? null, failed: this.statuses.get(kind)?.failed ?? false });
    void this.reads.invalidate(kind, async () => {
      const group = this.handlers.get(kind);
      if (!group) return;
      this.statuses.set(kind, { pending: true, lastSuccessAt: this.statuses.get(kind)?.lastSuccessAt ?? null, failed: this.statuses.get(kind)?.failed ?? false });
      let failed = false;
      // Snapshot membership: a registration during this pass schedules a trailing
      // pass. Removed owners must not start after an earlier awaited read.
      for (const handler of [...group]) {
        if (this.disposed) return;
        if (!group.has(handler)) continue;
        try { await handler(); } catch { failed = true; }
      }
      if (!this.disposed && this.handlers.get(kind) === group) {
        this.statuses.set(kind, { pending: false, failed,
          lastSuccessAt: failed ? this.statuses.get(kind)?.lastSuccessAt ?? null : Date.now() });
      }
    }).catch(() => { /* Owner failures preserve projections; later hints retry. */ });
  }
  refresh(): void { for (const kind of this.handlers.keys()) this.read(kind); }
  private changed() {
    if (this.disposed) return;
    try {
      const rows = decode(readCommittedMetadata(this.storage, key));
      for (const row of rows) if (this.observed.get(row.id) !== row.token) this.read(row.kind);
      this.observed = new Map(rows.map(row => [row.id, row.token]));
    } catch { /* Unavailable/malformed is not an empty authoritative directory. */ }
  }
  async notify(kind: string, hostId: string): Promise<void> {
    if (this.disposed) return;
    await this.storage.whenReady(); if (this.disposed) return;
    const id = JSON.stringify([kind, hostId]);
    const rows = decode(this.storage.getItem(key)).filter(row => row.id !== id);
    rows.push({ id, kind, hostId, token: crypto.randomUUID() });
    if (rows.length > 256) throw Error('Resource invalidation scope limit reached');
    this.storage.setItem(key, JSON.stringify(rows));
    await flushMetadataKey(this.storage, key);
  }
  dispose(): void { this.disposed = true; this.releases.splice(0).forEach(release => release()); this.handlers.clear(); this.statuses.clear(); this.reads.dispose(); }
}
