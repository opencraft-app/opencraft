import type { AccountMetadataStorage } from '../runtime/account-metadata-storage';

import type { BrowserEffectReceipts } from '@opencraft/browser-core';
import type { BrowserMetadataRetirement } from '@opencraft/browser-core/metadata-merge';

export interface RemoteBrowserResource {
  sessionId: string; lease: string; lifecycle: string; runtime: string; url: string | null;
  link: { pageId: string; tabId: string; scopeId: string; hostId: string | null } | null;
  createdAt: number | null;
}
export interface RemoteBrowserCatalog {
  sessions: RemoteBrowserResource[];
  capacity: { used: number; limit: number; accountUsed: number; accountLimit: number };
}
export type BrowserPresentationReason = 'conversation-unbound' | 'view-inactive' | 'tab-unavailable' | 'owner-mismatch' | 'hidden' | 'panel-unavailable' | 'paint-timeout';
export interface BrowserPresentationRequest {
  id: string; tabId: string; hostId: string; threadId: string;
  status: 'pending' | 'claimed' | 'visible' | 'failed' | 'cancelled' | 'expired';
  expiresAt: number; clientId?: string;
}
export type BrowserMetadataStorage = AccountMetadataStorage & {
  readPresentation?(lease: string, revision?: string): Promise<unknown>;
  onPresentationChanged?(listener: (lease: string) => void): () => void;
  readonly effectReceipts?: BrowserEffectReceipts;
  flush?(): Promise<void>;
  presentationRequests?(): readonly BrowserPresentationRequest[];
  acknowledgePresentation?(id: string, action: 'claim' | 'visible' | 'failed' | 'observe', reason?: BrowserPresentationReason): Promise<BrowserPresentationRequest>;
  readonly presentationClientId?: string;
  listResources?(): Promise<RemoteBrowserCatalog>;
  closeResource?(lease: string): Promise<void>;
  subscribe?(listener: () => void): () => void;
  retiredResources?(): readonly BrowserMetadataRetirement[];
};
interface DesktopStoragePort {
  read(): Promise<Record<string, string>>;
  write(key: string, value: string): Promise<void>;
}
export async function createDesktopBrowserStorage(): Promise<BrowserMetadataStorage> {
  const port = (window as unknown as { opencraftDesktop: { browserState: DesktopStoragePort } }).opencraftDesktop.browserState;
  const effects = (window as unknown as { opencraftDesktop: { browserEffects: {
    admit(request: unknown): Promise<any>; settle(request: unknown, status: string, result?: unknown): Promise<any>;
  } } }).opencraftDesktop.browserEffects;
  const unwrap = async (reply: Promise<any>) => {
    const result = await reply;
    if (!result.ok) throw Object.assign(Error(result.error.message), result.error);
    return result.value;
  };
  const values = new Map(Object.entries(await port.read()));
  let pending = Promise.resolve(), failure: unknown;
  const flush = async () => { await pending; if (failure) throw failure; };
  return {
    effectReceipts: {
      admit: async (request, options) => { await flush(); options?.authorize?.(); return unwrap(effects.admit(request)); },
      settle: async (request, status, result) => { await flush(); await unwrap(effects.settle(request, status, result)); },
    },
    flush,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      values.set(key, value);
      pending = pending.then(() => port.write(key, value)).catch(error => {
        failure = error;
        console.error("[browser] Unable to persist desktop browser metadata");
      });
    },
  };
}
