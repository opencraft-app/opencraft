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
    createCodexWorkspaceHooks({ hostId }: { hostId: string }): CodexWorkspaceHooks {
      check(hostId);
      return createWorkspaceNativeRouting({
        port: options.port,
        placement,
        authority: ownedAuthority,
        admit: admission.admit,
        onCleanupUnconfirmed: options.onCleanupUnconfirmed,
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
        await ownedAuthority.close();
      })()),
  };
}
