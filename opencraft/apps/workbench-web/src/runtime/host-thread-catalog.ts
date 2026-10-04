import type { SshConnectionView, SshCodexServerDescriptor } from "@opencraft/app-host-protocol";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import type { AppServerWorkbenchRuntime, HostRuntimeRegistry } from "@opencraft/workbench-runtime";

/** Read-only application projection; the backend remains the SSH authority. */
export interface ManagedHostCatalogSnapshot {
  readonly available: boolean | null;
  readonly authenticated: boolean;
  readonly items: readonly SshConnectionView[];
  readonly legacyServers: readonly SshCodexServerDescriptor[];
}

export interface ManagedHostCatalogSource {
  getSnapshot(): ManagedHostCatalogSnapshot;
  subscribe(listener: () => void): () => void;
  getAuthorizationEpoch(): number;
}

export function canReadHostThreadCatalog(
  profile: HostConnectionProfile,
  phase: string | undefined,
  management: ManagedHostCatalogSnapshot | null,
): boolean {
  if (!profile.enabled || !profile.includeInSidebar) return false;
  if (profile.hostKind === "remote-ssh" && management?.available === true) {
    if (!management.authenticated) return false;
    const row = management.items.find(item => item.serverId === profile.hostId);
    if (row) {
      if (!row.enabled || row.revision !== profile.revision) return false;
      // An explicitly connected backend may admit a catalog reader without
      // selecting it as the current chat target. A ready logical connection
      // also works when management's physical status has not been refreshed.
      return row.state === "open" || phase === "ready";
    }
    if (!management.legacyServers.some(server => server.serverId === profile.hostId)) return false;
    // Static recipes have no managed row; their authenticated live profile
    // still requires an explicitly established logical connection.
  }
  return profile.autoConnect || phase === "ready";
}

/** Establish only a logical reader through the existing registry. Never select
 * a Host, resume a Thread, or grant interaction ownership to discover history. */
export async function readHostThreadCatalog(input: {
  readonly profile: HostConnectionProfile;
  readonly currentProfile: () => HostConnectionProfile | undefined;
  readonly management: ManagedHostCatalogSource | null;
  readonly registry: Pick<HostRuntimeRegistry<AppServerWorkbenchRuntime>, "peekRuntime" | "ensureConnected">;
}) {
  // SSH authorization cannot revoke or invalidate a different Host's reads.
  const management = input.profile.hostKind === "remote-ssh" ? input.management : null;
  const authorizationEpoch = management?.getAuthorizationEpoch();
  const assertCurrent = () => {
    const current = input.currentProfile();
    if (!current || current.hostId !== input.profile.hostId
      || management?.getAuthorizationEpoch() !== authorizationEpoch || current.revision !== input.profile.revision
      || !canReadHostThreadCatalog(current, input.registry.peekRuntime(current.hostId)?.getSnapshot().phase,
        management?.getSnapshot() ?? null)) {
      throw new Error("此连接当前不可读取会话，请刷新连接列表。");
    }
  };
  assertCurrent();
  const runtime = await input.registry.ensureConnected(input.profile.hostId);
  assertCurrent();
  const page = await runtime.resources.threads.list({ cursor: null, limit: 50 });
  // Revocation/revision changes invalidate late read results as well as new
  // requests. No metadata from an old admission enters the current catalog.
  assertCurrent();
  return page;
}
