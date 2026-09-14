import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type {
  TransparentRuntimeLocatorPort,
} from "../types/transparent-runtime-locator.ts";
import type { RuntimeFilesystemPort } from "../types/workspace.ts";
import { threadRuntimeBackendKey } from "./transparent-thread-routing.ts";

type LocatorContext = HypernodeContext<
  | "runtimeWorkspace"
  | "threadExecution"
  | "threadManager"
  | "transparentBackendRegistry"
  | "transparentThreadBinding"
>;

/**
 * Locates live execution state without treating it as durable Thread state.
 * Binding and Runtime hints are only routing evidence; the backend registry
 * remains authoritative for whether a Runtime is actually alive.
 */
export class TransparentRuntimeLocatorService extends Service
  implements TransparentRuntimeLocatorPort {
  static inject = [
    "runtimeWorkspace",
    "threadExecution",
    "threadManager",
    "transparentBackendRegistry",
    "transparentThreadBinding",
  ] satisfies Inject<Pick<
    HypernodeServices,
    | "runtimeWorkspace"
    | "threadExecution"
    | "threadManager"
    | "transparentBackendRegistry"
    | "transparentThreadBinding"
  >>;

  declare protected ctx: LocatorContext;

  constructor(ctx: LocatorContext) {
    super(ctx, "transparentRuntimeLocator");
  }

  ownerConnection(
    state: Pick<TransparentBackendState, "backendKey"> | null | undefined,
    outerThreadId: string,
  ) {
    const execution = this.executionFor(state, outerThreadId);
    return execution?.connection ?? null;
  }

  ownerEpoch(
    state: Pick<TransparentBackendState, "backendKey"> | null | undefined,
    outerThreadId: string,
  ) {
    return this.executionFor(state, outerThreadId)?.epoch;
  }

  stateForOuter(
    outerThreadId: string,
    localFilesystem: RuntimeFilesystemPort,
  ): TransparentBackendState | null {
    const binding = this.ctx.transparentThreadBinding.bindings.get(outerThreadId);
    const runtimeHint = this.ctx.transparentThreadBinding.runtimeHintFor(outerThreadId);
    const ownerUserId = runtimeHint?.ownerUserId ??
      this.ctx.threadManager.ownerOf(outerThreadId);
    if (!ownerUserId) return null;

    const cwd = this.ctx.threadManager.find(outerThreadId)?.cwd;
    const realm = binding?.realm ?? (
      this.ctx.runtimeWorkspace.enabled && typeof cwd === "string" && cwd.startsWith("/workspace")
        ? "workspace"
        : "localhost"
    );
    const viewId = binding?.viewId ??
      this.ctx.runtimeWorkspace.viewIdForThread(outerThreadId);
    const filesystem = this.ctx.runtimeWorkspace.filesystemForRealm(realm, localFilesystem);
    const backends = this.ctx.transparentBackendRegistry.backends;

    const activeRuntimeId = this.ctx.threadExecution.table.get(outerThreadId)?.runtimeId;
    if (activeRuntimeId) {
      const active = backends.get(activeRuntimeId);
      if (active) return active;
    }
    if (runtimeHint?.backendKey) {
      const hinted = backends.get(runtimeHint.backendKey);
      if (hinted) return hinted;
    }

    const dedicatedKey = threadRuntimeBackendKey(
      ownerUserId,
      realm,
      viewId,
      outerThreadId,
    );
    void filesystem;
    return backends.get(dedicatedKey) ?? null;
  }

  private executionFor(
    state: Pick<TransparentBackendState, "backendKey"> | null | undefined,
    outerThreadId: string,
  ) {
    const execution = this.ctx.threadExecution.table.get(outerThreadId);
    if (!execution) return null;
    if (execution.runtimeId && state && execution.runtimeId !== state.backendKey) return null;
    return execution;
  }
}
