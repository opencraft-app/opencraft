import { WorkspaceBrowserClient } from "./browser-client.js";
import {
  installWorkspaceBrowserRouting,
  type WorkspaceBrowserDescriptor,
  type WorkspaceBrowserLease,
} from "./workspace-browser-composition.mjs";
import { WorkspaceTerminalClient } from "./terminal-client.js";
import type { EnvironmentExecutionScope } from "@opencraft/execution-environment";
import type { HostTerminalService, HostTerminalServiceSelector } from "../host-terminal-transport.js";
import { WorkspaceArtifactClient } from "./artifact-client.js";
import type { AssetStoragePort, AssetAdmission } from "@opencraft/plugin-assets/server";
import type { CodexWorkspaceHooks } from "../codex-workspace-hooks.mjs";
import type { HostFileBinding, HostFileSelector } from "../host-filesystem-transport.js";
import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { createWorkspaceExecutionAuthority } from "@opencraft/sandbox-node/workspace-execution-channel";
import type { WorkspaceExecutionPort } from "./execution-owner.js";
import { WorkspaceNativeAdmission } from "./native-admission.js";
import { WorkspacePlacementProjection } from "./placement-projection.js";
import { createWorkspaceNativeRouting } from "./native-routing.js";

/** Gateway composition over an already owned Assets Worker. Never opens storage,
 * provisions compute, reads installed secrets, or constructs a second Bot pool. */
export async function openWorkspaceExecutionService(options: {
  port: WorkspaceExecutionPort & Pick<AssetStoragePort, "workspaceCatalog">;
  actors: ConstructorParameters<typeof WorkspaceNativeAdmission>[0]["actors"];
  access: ConstructorParameters<typeof WorkspaceNativeAdmission>[0]["access"];
  socketPath: string;
  token: string;
  onCleanupUnconfirmed(): void;
}) {
  const admission = new WorkspaceNativeAdmission(options),
    placement = new WorkspacePlacementProjection(options.port);
  let authority: Awaited<ReturnType<typeof createWorkspaceExecutionAuthority>> | undefined;
  let closed = false,
    closing: Promise<void> | undefined;
  const check = (hostId: string) => {
    if (closed || hostId !== "local-codex") throw Error("Workspace Host unavailable");
  };
  try {
    await placement.refresh();
    authority = await createWorkspaceExecutionAuthority({ socketPath: options.socketPath, token: options.token });
  } catch (cause) {
    placement.close();
    admission.close();
    throw cause;
  }
  const ownedAuthority = authority;
  const artifacts = new WorkspaceArtifactClient(options.port);
  const terminals = new Map<string, Promise<WorkspaceTerminalClient>>();
  const browserLeases = new Map<string, WorkspaceBrowserLease>();
  const browserPeers = new Set<WorkspaceBrowserClient>();
  const browserConnecting = new Set<Promise<WorkspaceBrowserClient>>();
  const browserClosing = new Set<Promise<void>>();
  let browserInstalled = false;
  const assetAdmission = (context: TransportSubmissionContext): AssetAdmission => {
    const access = admission.admit(context);
    return {
      scope: "actor:" + access.actorId,
      expiresAt: access.expiresAt,
      permit: access.requestPermit,
      allowCustomEndpoints: false,
      canManagePlatform: false,
    };
  };
  return {
    connectBrowserRouting({
      service,
      assertThreadAccess,
    }: {
      service: unknown;
      assertThreadAccess(descriptor: WorkspaceBrowserDescriptor): void;
    }) {
      if (closed || browserInstalled) throw Error("Workspace browser routing already installed");
      installWorkspaceBrowserRouting({
        service,
        resolveConversation: async (descriptor, local) => {
          const assertAccess = () => {
            if (closed) throw Error("Workspace browser service closed");
            assertThreadAccess(descriptor);
          };
          assertAccess();
          if (descriptor.hostId !== "local-codex" || descriptor.threadId === null)
            return { lease: local, assertCurrent: assertAccess };
          const threadId = descriptor.threadId;
          if (!placement.has(threadId)) {
            if (!placement.isKnownLocal(threadId)) throw Error("Native browser placement unavailable");
            return { lease: local, assertCurrent: assertAccess };
          }
          const access = admission.admitResource(descriptor.ownerId),
            selection = await options.port.workspaceSelection(access, threadId);
          assertAccess();
          if (selection.kind !== "bound") throw Error("Workspace browser cannot become local");
          const key = JSON.stringify([
            access.actorId,
            access.generation,
            access.membershipRevision,
            threadId,
            selection.workspaceId,
            selection.generation,
          ]);
          let lease = browserLeases.get(key);
          if (!lease) {
            for (const [oldKey, oldLease] of browserLeases) {
              const old = JSON.parse(oldKey) as unknown[];
              if (old[0] === access.actorId && old[3] === threadId && oldKey !== key) {
                browserLeases.delete(oldKey);
                continue;
              }
              try {
                oldLease.assertCurrent();
              } catch {
                browserLeases.delete(oldKey);
              }
            }
            if (browserLeases.size >= 128) throw Error("Workspace browser bindings exhausted");
            let peer: WorkspaceBrowserClient | undefined, connecting: Promise<WorkspaceBrowserClient> | undefined;
            const authorize = () => {
              if (closed || Atomics.load(access.resourcePermit, 0) !== 1)
                throw Error("Workspace browser resource retired");
              const current = admission.admitResource(access.actorId);
              if (
                current.generation !== access.generation ||
                current.membershipRevision !== access.membershipRevision ||
                current.resourcePermit !== access.resourcePermit
              )
                throw Error("Workspace browser authority changed");
            };
            lease = {
              assertCurrent: authorize,
              connect: () => {
                authorize();
                if (peer?.connected) return Promise.resolve(peer);
                if (connecting) return connecting;
                let work!: Promise<WorkspaceBrowserClient>;
                work = (async () => {
                  await peer?.close();
                  const current = admission.admitResource(access.actorId);
                  authorize();
                  const next = await WorkspaceBrowserClient.open({
                    port: options.port,
                    access: current,
                    threadId,
                    lease: { workspaceId: selection.workspaceId, generation: selection.generation },
                    authorize,
                  });
                  try {
                    authorize();
                  } catch (cause) {
                    await next.close();
                    throw cause;
                  }
                  browserPeers.add(next);
                  next.once("exit", () => {
                    const closing = next.close();
                    browserClosing.add(closing);
                    void closing
                      .then(
                        () => browserPeers.delete(next),
                        () => {},
                      )
                      .finally(() => browserClosing.delete(closing));
                  });
                  peer = next;
                  return next;
                })().finally(() => {
                  connecting = undefined;
                  browserConnecting.delete(work);
                });
                connecting = work;
                browserConnecting.add(work);
                return work;
              },
            };
            browserLeases.set(key, lease);
          }
          lease.assertCurrent();
          return { lease, assertCurrent: assertAccess };
        },
      });
      browserInstalled = true;
    },
    createCodexWorkspaceHooks({ hostId }: { hostId: string }): CodexWorkspaceHooks {
      check(hostId);
      return createWorkspaceNativeRouting({
        port: options.port,
        placement,
        authority: ownedAuthority,
        admit: admission.admit,
        onCleanupUnconfirmed: options.onCleanupUnconfirmed,
        readWorkspaceArtifact: async (threadId, path, context, signal) => {
          check(hostId);
          if (!placement.has(threadId)) throw Error("Workspace output has no remote placement");
          const access = admission.admit(context);
          return artifacts.read(
            access,
            threadId,
            path,
            () => {
              check(hostId);
              admission.admit(context);
            },
            signal,
          );
        },
        prepareWorkspaceArtifact: async (artifact, threadId, context, signal) => {
          check(hostId);
          if (!placement.has(threadId)) {
            if (!placement.isKnownLocal(threadId)) throw Error("Native attachment placement unavailable");
            return null;
          }
          if (!context) throw Error("Workspace attachment authority unavailable");
          const access = admission.admit(context);
          const delivered = await artifacts.upload(
            access,
            threadId,
            artifact,
            () => {
              check(hostId);
              admission.admit(context);
            },
            signal,
          );
          check(hostId);
          admission.admit(context);
          return delivered;
        },
      });
    },
    async readCatalog(hostId: string, context: TransportSubmissionContext) {
      check(hostId);
      const access = assetAdmission(context);
      const result = await options.port.workspaceCatalog(access);
      check(hostId);
      admission.admit(context);
      return result;
    },
    async readFileScope(hostId: string, context: TransportSubmissionContext, threadId: string) {
      check(hostId);
      const access = admission.admit(context);
      if (!placement.has(threadId)) {
        if (!placement.isKnownLocal(threadId)) throw Error("Native file placement unavailable");
        return { kind: "host" as const };
      }
      const result = await options.port.workspaceFileScope(access, threadId);
      check(hostId);
      admission.admit(context);
      return result;
    },
    async selectHostTerminalService(
      hostId: string,
      scope: EnvironmentExecutionScope,
      context: TransportSubmissionContext,
      local: HostTerminalServiceSelector,
    ): Promise<HostTerminalService> {
      if (hostId !== "local-codex" || scope.threadId === null) return local(scope, context);
      check(hostId);
      if (!placement.has(scope.threadId)) {
        if (!placement.isKnownLocal(scope.threadId)) throw Error("Native terminal placement unavailable");
        return local(scope, context);
      }
      const access = admission.admit(context),
        selection = await options.port.workspaceSelection(access, scope.threadId);
      if (selection.kind !== "bound" || scope.projectId !== null) throw Error("Workspace terminal binding unavailable");
      const key = JSON.stringify([
        access.actorId,
        access.generation,
        access.membershipRevision,
        scope.threadId,
        selection.workspaceId,
        selection.generation,
      ]);
      let pending = terminals.get(key);
      if (!pending) {
        if (terminals.size >= 128) throw Error("Workspace terminal bindings exhausted");
        pending = options.port
          .workspaceTerminalOpen(access, scope.threadId, {
            workspaceId: selection.workspaceId,
            generation: selection.generation,
          })
          .then(
            (token) =>
              new WorkspaceTerminalClient({
                port: options.port,
                token,
                threadId: scope.threadId!,
                actorId: access.actorId,
                generation: access.generation,
                admit: admission.admit,
                onCleanupUnconfirmed: options.onCleanupUnconfirmed,
              }),
          );
        terminals.set(key, pending);
        void pending.catch(() => {
          if (terminals.get(key) === pending) terminals.delete(key);
        });
      }
      const terminal = await pending;
      check(hostId);
      admission.admit(context);
      return terminal;
    },
    async selectHostFiles(
      hostId: string,
      context: TransportSubmissionContext,
      params: unknown,
      local: HostFileSelector,
    ): Promise<HostFileBinding> {
      if (!params || typeof params !== "object" || !Object.hasOwn(params, "workspaceThreadId"))
        return local(context, params);
      check(hostId);
      const threadId = (params as { workspaceThreadId: unknown }).workspaceThreadId;
      if (typeof threadId !== "string" || !placement.has(threadId)) throw Error("Workspace file placement unavailable");
      const access = admission.admit(context),
        selected = await options.port.workspaceSelection(access, threadId);
      if (selected.kind !== "bound") throw Error("Workspace files cannot become local");
      const assertCurrent = async () => {
        check(hostId);
        admission.admit(context);
        const current = await options.port.workspaceSelection(access, threadId);
        if (JSON.stringify(current) !== JSON.stringify(selected)) throw Error("Workspace file generation changed");
      };
      await assertCurrent();
      return {
        assertCurrent,
        files: {
          request: async (method, input, signal) => {
            signal?.throwIfAborted();
            await assertCurrent();
            const abort = () => Atomics.store(access.requestPermit, 0, 0);
            signal?.addEventListener("abort", abort, { once: true });
            try {
              signal?.throwIfAborted();
              const result = await options.port.workspaceFileRequest(access, threadId, method, input);
              signal?.throwIfAborted();
              await assertCurrent();
              return result;
            } finally {
              signal?.removeEventListener("abort", abort);
            }
          },
        },
      };
    },
    close: () =>
      (closing ??= (async () => {
        closed = true;
        placement.close();
        admission.close();
        await Promise.allSettled([...browserConnecting]);
        const browserOutcomes = await Promise.allSettled([...browserPeers].map((peer) => peer.close()));
        await Promise.allSettled([...browserClosing]);
        browserPeers.clear();
        browserLeases.clear();
        const results = await Promise.allSettled(
          [...terminals.values()].map(async (terminal) => (await terminal).close()),
        );
        terminals.clear();
        await ownedAuthority.close();
        const failures = [...browserOutcomes, ...results].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) throw new AggregateError(failures, "Workspace terminal detach unconfirmed");
      })()),
  };
}
