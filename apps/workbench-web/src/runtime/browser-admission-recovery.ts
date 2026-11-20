/** Navigation belongs to the browser shell, never to transport error guessing. */
export interface BrowserAdmissionRecoveryPort {
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly key: string;
  flush(): Promise<void>;
  reload(): void;
}

export function createBrowserAdmissionRecovery(port: BrowserAdmissionRecoveryPort) {
  let disposed = false;
  let pending: Promise<void> | null = null;
  return {
    observe(status: number): void {
      if (disposed || pending) return;
      try {
        // Only confirmed admission ends an authentication cycle. A successful
        // document load or legacy 404 must not rearm a broken-login reload loop.
        if (status === 204) { port.storage.removeItem(port.key); return; }
        if (status !== 401 || port.storage.getItem(port.key) !== null) return;
        // Persist before yielding: simultaneous public/SSH probes and the next
        // page instance share this tab-scoped fence. Storage failure falls back
        // to the existing manual sign-in UI instead of unguarded navigation.
        port.storage.setItem(port.key, '1');
        pending = (async () => {
          await port.flush();
          if (!disposed) port.reload();
        })().catch(() => undefined).finally(() => { pending = null; });
      } catch { /* Keep the manual recovery surface when tab storage is unavailable. */ }
    },
    dispose(): void { disposed = true; },
  };
}
