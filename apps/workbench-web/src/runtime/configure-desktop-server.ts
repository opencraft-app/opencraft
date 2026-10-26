import type { DesktopServerPort } from '@opencraft/app-host-protocol/desktop-server';
import type { HostConnectionProfile, ProvisionHostInput } from '@opencraft/workbench-runtime';

/** One user configuration transaction. Login does not itself commit a Host or navigation. */
export async function configureDesktopServer(input: {
  readonly origin: string;
  readonly signal: AbortSignal;
  readonly port: DesktopServerPort;
  readonly profiles: readonly HostConnectionProfile[];
  readonly provision: (input: ProvisionHostInput, options?: { signal?: AbortSignal }) => Promise<HostConnectionProfile>;
}): Promise<HostConnectionProfile> {
  const id = crypto.randomUUID();
  const cancel = () => { void input.port.cancel(id).catch(() => {}); };
  input.signal.throwIfAborted();
  input.signal.addEventListener('abort', cancel, { once: true });
  try {
    const connection = await input.port.prepare(id, input.origin);
    input.signal.throwIfAborted();
    if (!connection) throw new DOMException('Server sign-in cancelled', 'AbortError');
    const hostId = 'desktop-server:' + connection.accountKey;
    const existing = input.profiles.find(profile => profile.hostId === hostId && profile.enabled);
    if (existing) return existing;
    return await input.provision({ hostId: input.profiles.some(profile => profile.hostId === hostId) ? undefined : hostId,
      displayName: new URL(connection.origin).host, providerId: 'opencraft.desktop-server', providerConfig: { ...connection },
      hostKind: 'remote-control', transportEndpoint: connection.origin, executionLocation: new URL(connection.origin).host,
      autoConnect: true, includeInSidebar: true }, { signal: input.signal });
  } finally { input.signal.removeEventListener('abort', cancel); }
}
