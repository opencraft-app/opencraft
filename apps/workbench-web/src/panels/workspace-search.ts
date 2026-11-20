import type { FuzzyFileSearchResult } from '@opencraft/appserver-protocol/generated';
import type { AppServerFileSystemResourcePort } from '@opencraft/workbench-runtime';
import { useEffect, useState } from 'react';
export interface WorkspaceSearchState {
  readonly status: 'idle' | 'searching' | 'ready' | 'error' | 'unavailable';
  readonly results: readonly FuzzyFileSearchResult[];
}
/** A lease per query intent also fences A -> B -> A and query-less completion notifications. */
export function startWorkspaceSearch(fileSystem: AppServerFileSystemResourcePort, roots: readonly string[], query: string,
  publish: (state: WorkspaceSearchState) => void) {
  let active = true;
  let session: Awaited<ReturnType<AppServerFileSystemResourcePort['createFuzzyFileSearchSession']>> | null = null;
  let results: readonly FuzzyFileSearchResult[] = [];
  void fileSystem.createFuzzyFileSearchSession({ roots,
    onUpdated(update) { if (active && update.query === query) { results = update.files; publish({ status: 'ready', results }); } },
    onCompleted() { if (active) publish({ status: 'ready', results }); },
  }).then(async lease => {
    if (!active) { await lease.stop(); return; }
    session = lease; await lease.update(query);
  }).catch(() => { if (active) publish({ status: 'error', results: [] }); });
  return () => { active = false; void session?.stop().catch(() => undefined); };
}
export function useWorkspaceSearch(fileSystem: AppServerFileSystemResourcePort, roots: readonly string[], query: string,
  scope: string, enabled: boolean, supported: boolean) {
  const normalized = query.trim(), rootsKey = roots.join('\u0000');
  const [attempt, retry] = useState(0);
  const key = JSON.stringify([scope, rootsKey, normalized, enabled, supported, attempt]);
  const [receipt, setReceipt] = useState<{ key: string; state: WorkspaceSearchState } | null>(null);
  useEffect(() => {
    if (!enabled || !supported || !normalized || roots.length === 0) return;
    let stop: (() => void) | undefined;
    const timer = window.setTimeout(() => { stop = startWorkspaceSearch(fileSystem, roots, normalized, state => setReceipt({ key, state })); }, 100);
    return () => { window.clearTimeout(timer); stop?.(); };
  }, [fileSystem, key]);
  const state: WorkspaceSearchState = !supported ? { status: 'unavailable', results: [] }
    : !enabled || !normalized ? { status: 'idle', results: [] }
    : receipt?.key === key ? receipt.state : { status: 'searching', results: [] };
  return { ...state, retry: () => retry(value => value + 1) };
}
