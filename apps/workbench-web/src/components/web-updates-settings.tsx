import { NavigationItem } from "@opencraft/design-system-web/navigation";
import { RefreshIcon as RefreshCw } from "@opencraft/design-system-web/action-icons";
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormattedMessage } from '@opencraft/i18n/react';
import { WEB_UPDATE_PATH, parseWebUpdateStatus } from '@opencraft/web-update-protocol';
import type { WebUpdateStatus } from '@opencraft/web-update-protocol';

import { createDeferredView } from '@opencraft/extension-react';
import { browserServerContext } from '../runtime/server-context';

export function currentPlatform(): "web" | "electron" {
  return (globalThis as typeof globalThis & { opencraftDesktop?: { readonly kind?: string } })
    .opencraftDesktop?.kind === "electron" ? "electron" : "web";
}

export function hasManagedWebUpdates(): boolean {
  return !browserServerContext() && typeof document !== 'undefined' && document.querySelector('meta[name="opencraft-web-updates"]')?.getAttribute('content') === WEB_UPDATE_PATH;
}
export const queryKey = ['web-deployment-updates'] as const;
export function useUpdates() {
  const enabled = currentPlatform() === 'web' && hasManagedWebUpdates();
  return useQuery({ queryKey, enabled, queryFn: async ({ signal }) => {
    const response = await fetch(WEB_UPDATE_PATH, { signal, cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('Website update service unavailable');
    return parseWebUpdateStatus(await response.json());
  }, retry: false, refetchInterval: query => query.state.data?.checking || (query.state.data?.job && !['completed', 'failed'].includes(query.state.data.job.phase)) ? 1000 : 30_000 });
}

export interface ManagedWebUpdateNotice {
  visible: boolean;
  updateAvailable: boolean;
  needsRefresh: boolean;
  latestVersion: string | null;
  updating: boolean;
}

export function projectManagedWebUpdateNotice(status: WebUpdateStatus | undefined, currentBuild: string | null): ManagedWebUpdateNotice {
  const needsRefresh = Boolean(status && currentBuild && currentBuild !== status.current.buildId);
  const updateAvailable = Boolean(status?.updateAvailable);
  return {
    visible: updateAvailable || needsRefresh,
    updateAvailable,
    needsRefresh,
    latestVersion: status?.latest?.version ?? null,
    updating: Boolean(status?.job && !['completed', 'failed'].includes(status.job.phase)),
  };
}

export function useManagedWebUpdateNotice(): ManagedWebUpdateNotice {
  const query = useUpdates();
  const client = useQueryClient();
  const status = query.data;
  const checkingRef = useRef(false);

  useEffect(() => {
    if (
      !status?.enabled ||
      status.checkedAt !== null ||
      status.checking ||
      Boolean(status.checkError) ||
      checkingRef.current
    ) {
      return;
    }
    checkingRef.current = true;
    void (async () => {
      try {
        await fetch(`${WEB_UPDATE_PATH}/check`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
      } catch {
        // silent auto-check ignores network error; query cache will reflect status
      } finally {
        await client.invalidateQueries({ queryKey });
      }
    })();
  }, [status?.enabled, status?.checkedAt, status?.checking, status?.checkError, client]);

  const currentBuild = typeof document !== 'undefined'
    ? document.querySelector('meta[name="opencraft-build-id"]')?.getAttribute('content') ?? null
    : null;
  return projectManagedWebUpdateNotice(status, currentBuild);
}
export function WebUpdatesNavigation({ selected, onOpen }: { selected: boolean; onOpen: () => void }) {
  const query = useUpdates();
  if (!query.data?.enabled) return null;
  return <NavigationItem type="button" aria-current={selected ? 'page' : undefined} onClick={onOpen}><RefreshCw size={16} /><span><FormattedMessage id="webUpdates.title" defaultMessage="Website updates" /></span></NavigationItem>;
}
export const WebUpdatesSettings = createDeferredView(async () => (await import("./web-updates-settings-content")).WebUpdatesSettings);
