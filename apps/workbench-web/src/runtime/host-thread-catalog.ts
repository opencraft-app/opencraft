import { threadDirectoryIncomplete, THREAD_DIRECTORY_SNAPSHOTS, THREAD_DIRECTORY_SNAPSHOT_START, THREAD_DIRECTORY_MERKLE } from "@opencraft/appserver-protocol";
import { reconcileThreadCatalog } from "./thread-catalog-recovery";
import { beginObservedOperation } from "./observability";
import type { SshConnectionView, SshServerDescriptor } from "@opencraft/app-host-protocol";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import type { AppServerWorkbenchRuntime, HostRuntimeRegistry } from "@opencraft/workbench-runtime";
import type { ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import { managedCatalogDiscoveryPhase, mergeThreadCatalogPages } from "./thread-catalog-query";

/** Read-only application projection; the backend remains the SSH authority. */
export interface ManagedHostCatalogSnapshot {
  readonly available: boolean | null;
  readonly authenticated: boolean;
  readonly items: readonly SshConnectionView[];
  readonly legacyServers: readonly SshServerDescriptor[];
  readonly refreshing: boolean;
  readonly error: string | null;
}

export interface ManagedHostCatalogSource {
  getSnapshot(): ManagedHostCatalogSnapshot;
  subscribe(listener: () => void): () => void;
  getAuthorizationEpoch(): number;
  refresh(): Promise<void>;
}

/** Chat consumes catalog/admission changes, not healthy background poll progress.
 * Keep the controller's full snapshot available to connection management. The
 * primitive is stable across freshly decoded but unchanged catalog responses. */
export function managedHostCatalogSignature(source: ManagedHostCatalogSource | null): string | null {
  if (source === null) return null;
  const snapshot = source.getSnapshot();
  return JSON.stringify([
    source.getAuthorizationEpoch(),
    snapshot.available,
    snapshot.authenticated,
    snapshot.items,
    snapshot.legacyServers,
    snapshot.error,
    managedCatalogDiscoveryPhase(snapshot),
  ]);
}

/** Cached metadata remains displayable during physical reconnects. This does
 * not admit requests or execution; query keys still fence recipe/auth epochs. */
export function canDisplayHostThreadCatalog(
  profile: HostConnectionProfile,
  management: ManagedHostCatalogSnapshot | null,
): boolean {
  if (!profile.enabled || !profile.includeInSidebar) return false;
  if (profile.hostKind === "remote-ssh" && management?.available === true) {
    if (!management.authenticated) return false;
    const row = management.items.find(item => item.serverId === profile.hostId);
    if (row) return row.enabled && row.revision === profile.revision;
    return management.legacyServers.some(server => server.serverId === profile.hostId);
  }
  return true;
}

export function canReadHostThreadCatalog(
  profile: HostConnectionProfile,
  phase: string | undefined,
  management: ManagedHostCatalogSnapshot | null,
): boolean {
  if (!profile.enabled || !profile.includeInSidebar) return false;
  // The runtime owns recovery for every provider. In particular, a five-second
  // management poll may still report open after the logical link has failed.
  if (phase === "reconnecting" || phase === "error" || phase === "disposed") return false;
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
  return profile.autoConnect || phase === "ready" || isCurrentServerCatalog(profile);
}

/** A visible durable WebSocket on this website is its metadata source, not an
 * undiscovered remote machine. Reading its directory establishes no Thread or
 * execution ownership, even when another engine is the selected chat Host. */
function isCurrentServerCatalog(profile: HostConnectionProfile): boolean {
  if (profile.providerId !== "opencraft.websocket" || profile.hostKind !== "durable"
    || typeof window === "undefined" || !profile.providerConfig
    || typeof profile.providerConfig !== "object" || Array.isArray(profile.providerConfig)) return false;
  const value = (profile.providerConfig as { url?: unknown }).url;
  if (typeof value !== "string") return false;
  try {
    const origin = new URL(window.location.href);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
    origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    const endpoint = new URL(value, origin);
    return endpoint.origin === origin.origin && !endpoint.username && !endpoint.password;
  } catch { return false; }
}

/** A connection precondition failed before any catalog read could start. */
export class HostThreadCatalogUnavailableError extends Error {
  readonly code = "HOST_THREAD_CATALOG_UNAVAILABLE" as const;
  constructor() {
    super("此连接当前不可读取会话，请刷新连接列表。");
    this.name = "HostThreadCatalogUnavailableError";
  }
}

export function isHostThreadCatalogUnavailableError(error: unknown): boolean {
  return error instanceof HostThreadCatalogUnavailableError
    || (typeof error === "object" && error !== null
      && (error as { code?: unknown }).code === "HOST_THREAD_CATALOG_UNAVAILABLE");
}

/** Establish only a logical reader through the existing registry. Never select
 * a Host, resume a Thread, or grant interaction ownership to discover history. */
export async function readHostThreadCatalog(input: {
  readonly profile: HostConnectionProfile;
  readonly currentProfile: () => HostConnectionProfile | undefined;
  readonly management: ManagedHostCatalogSource | null;
  readonly registry: Pick<HostRuntimeRegistry<AppServerWorkbenchRuntime>, "peekRuntime" | "ensureConnected">;
  /** Compatibility reader for consumers requiring a complete metadata directory. */
  readonly onInitialPage?: (page: ThreadListResponse) => void;
  readonly signal?: AbortSignal;
  /** Read one independently cacheable metadata page when specified. */
  readonly pageCursor?: string | null;
  readonly trace?: import("@opencraft/appserver-protocol").RequestTrace;
  readonly recoveryBase?: ThreadListResponse;
  readonly loadRecoveryBase?: () => Promise<ThreadListResponse | undefined>;
}) {
  // SSH authorization cannot revoke or invalidate a different Host's reads.
  const management = input.profile.hostKind === "remote-ssh" ? input.management : null;
  const authorizationEpoch = management?.getAuthorizationEpoch();
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    const current = input.currentProfile();
    if (!current || current.hostId !== input.profile.hostId
      || management?.getAuthorizationEpoch() !== authorizationEpoch || current.revision !== input.profile.revision
      || !canReadHostThreadCatalog(current, input.registry.peekRuntime(current.hostId)?.getSnapshot().phase,
        management?.getSnapshot() ?? null)) {
      throw new HostThreadCatalogUnavailableError();
    }
  };
  // A connection precondition is not a catalog attempt. Starting observation
  // after it prevents a false 0ms catalog failure when the reader is not ready.
  assertCurrent();
  const finishFull: ReturnType<typeof beginObservedOperation> = "pageCursor" in input ? () => {} : beginObservedOperation("catalog_complete");
  const finishFirst: ReturnType<typeof beginObservedOperation> = input.pageCursor == null ? beginObservedOperation("catalog_first") : () => {};
  const pages: ThreadListResponse[] = [];
  try {
  const runtime = await input.registry.ensureConnected(input.profile.hostId);
  assertCurrent();
  const generation = runtime.getSnapshot().connectionGeneration;
  const read = async (cursor: string | null) => {
    assertCurrent();
    if (input.registry.peekRuntime(input.profile.hostId) !== runtime || runtime.getSnapshot().connectionGeneration !== generation) throw new HostThreadCatalogUnavailableError();
    const page = await runtime.resources.threads.list({ cursor, limit: 50 }, { trace: input.trace });
    assertCurrent();
    if (input.registry.peekRuntime(input.profile.hostId) !== runtime || runtime.getSnapshot().connectionGeneration !== generation) throw new HostThreadCatalogUnavailableError();
    return page;
  };
  // Complete-directory callers follow every metadata cursor. The navigation
  // query uses independently cacheable pages under the same admission fence.
  const cursors = new Set<string>();
  let cursor: string | null = input.pageCursor ?? null;
  const snapshotCapability = runtime.resources.host?.getInitializeResult?.()?.capabilities?.extensions?.[THREAD_DIRECTORY_SNAPSHOTS] as { version?: unknown } | undefined;
  const merkleCapability = runtime.resources.host?.getInitializeResult?.()?.capabilities?.extensions?.[THREAD_DIRECTORY_MERKLE] as { version?: unknown } | undefined;
  if (cursor === null && merkleCapability?.version === 1) {
    const base = input.recoveryBase ?? await input.loadRecoveryBase?.();
    assertCurrent();
    let recovered: ThreadListResponse | null = null;
    if (base) {
      const finish = beginObservedOperation("recovery", { caller: "sidebar-catalog" });
      let transferred = 0;
      try {
        recovered = await reconcileThreadCatalog(base, async c => { const page = await read(c); transferred += page.data.length; return page; }, input.signal);
        finish(recovered ? "ok" : "empty", { count: transferred });
      } catch (error) { finish(input.signal?.aborted ? "aborted" : "failed", { count: transferred }); throw error; }
    }
    if (recovered) { finishFirst("ok", { count: recovered.data.length }); finishFull("ok", { count: recovered.data.length }); return recovered; }
  }
  if (cursor === null && snapshotCapability?.version === 1) cursor = THREAD_DIRECTORY_SNAPSHOT_START;
  do {
    assertCurrent();
    const page = await read(cursor);
    // Fence every page, including a revoked final response. Never publish a
    // partial catalog as a successful complete search after a failed page.
    assertCurrent();
    pages.push(page);
    if ("pageCursor" in input) {
      finishFirst("ok", { count: page.data.length });
      finishFull("ok", { count: page.data.length });
      return page;
    }
    if (pages.length === 1) finishFirst("ok", {count:page.data.length});
    cursor = page.nextCursor ?? null;
    if (cursor !== null && cursors.has(cursor)) throw new Error("Repeated thread catalog cursor");
    if (cursor !== null) cursors.add(cursor);
    if (pages.length === 1 && cursor !== null && page.data.length > 0) input.onInitialPage?.(page);
  } while (cursor !== null);
  if (pages.some(threadDirectoryIncomplete)) {
    if (pages[0]!.data.length) input.onInitialPage?.(pages[0]!);
    throw new Error("Thread directory is still synchronizing");
  }
  // The first page backfills old pins, which can recur in later recent pages.
  finishFull("ok", {count:mergeThreadCatalogPages(pages).length});
  return { ...pages[0]!, data: mergeThreadCatalogPages(pages), nextCursor: null };
  } catch(error) { const outcome=input.signal?.aborted?"aborted":"failed";
    // The first page already settled ok; a later-page failure must not rewrite
    // that successful first-screen observation as aborted/failed.
    if (pages.length === 0) finishFirst(outcome);
    finishFull(outcome);throw error; }
}
