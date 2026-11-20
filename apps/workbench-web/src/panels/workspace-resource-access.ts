import type { AppServerFileSystemResourcePort } from '@opencraft/workbench-runtime';
import { workspacePathParent } from './workspace-resource-model';

export function workspaceQueryAffected(key: readonly unknown[], hostId: string, scope: string, changedPaths: readonly string[]): boolean {
  if (key[0] !== 'appserver-fs' || key[1] !== hostId || key[4] !== scope || typeof key[3] !== 'string') return false;
  const path = key[3];
  return changedPaths.some(changed => path === changed || path.startsWith(`${changed.replace(/\/$/u, '')}/`)
    || (key[2] === 'directory' && path === workspacePathParent(changed)));
}
interface WatchEntry { users: number; closed: boolean; dispose?: () => Promise<void>; }
/** Shared by panels using one QueryClient; the final consumer releases the Host lease. */
export class WorkspaceWatchPool {
  private entries = new Map<string, WatchEntry>();
  acquire(fileSystem: AppServerFileSystemResourcePort, scope: string, path: string, changed: (paths: readonly string[]) => void): () => void {
    const key = JSON.stringify([scope, path]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { users: 0, closed: false };
      this.entries.set(key, entry);
      const owned = entry;
      void fileSystem.watch(path, paths => { if (!owned.closed) changed(paths); }).then(lease => {
        if (owned.closed) return lease.dispose();
        owned.dispose = () => lease.dispose();
      }).catch(() => {
        // No fake watch support: explicit refresh remains available. A new consumer can retry.
        if (this.entries.get(key) === owned) this.entries.delete(key);
      });
    }
    entry.users++;
    let released = false;
    const owned = entry;
    return () => {
      if (released) return;
      released = true;
      if (--owned.users !== 0) return;
      owned.closed = true;
      if (this.entries.get(key) === owned) this.entries.delete(key);
      void owned.dispose?.().catch(() => undefined);
    };
  }
}
const pools = new WeakMap<object, WorkspaceWatchPool>();
export function workspaceWatchPool(owner: object): WorkspaceWatchPool {
  let pool = pools.get(owner);
  if (!pool) { pool = new WorkspaceWatchPool(); pools.set(owner, pool); }
  return pool;
}
