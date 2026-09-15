import { Service, type Inject } from "@deepseek-ai/cordis";
import type { JsonRpcRequest, JsonRpcResponse } from "../types/appserver.ts";
import type {
  TransparentBackendFilesystemPort,
  TransparentBackendState,
} from "../types/transparent-backend.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { TransparentRuntimeAccessPort } from
  "../types/transparent-runtime-access.ts";
import type { LocalRuntimeFilesystemPort } from "../types/workspace.ts";
import type { ExecutionProfile } from "./execution-profile.ts";
import { createLocalExecutionFilesystem } from "./local-execution-filesystem.ts";
import { threadRuntimeBackendKey } from "./transparent-thread-routing.ts";

type Dependencies =
  | "runtimeWorkspace"
  | "transparentProtocolMapper"
  | "transparentRuntimeLocator";

/**
 * Resolves execution filesystems and namespaces for replaceable runtimes.
 *
 * This is the only transparent-runtime service allowed to choose between the
 * host-local filesystem and a Workspace driver.  Public Thread IDs and paths
 * therefore stay independent from Codex, DSH, SSH and future sandbox drivers.
 */
export class TransparentRuntimeAccessService extends Service
  implements TransparentRuntimeAccessPort {
  static inject = [
    "runtimeWorkspace",
    "transparentProtocolMapper",
    "transparentRuntimeLocator",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private initializedFilesystem: TransparentBackendFilesystemPort | null = null;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentRuntimeAccess");
  }

  get localFilesystem(): TransparentBackendFilesystemPort {
    if (!this.initializedFilesystem) {
      throw new Error("transparent runtime access is not initialized");
    }
    return this.initializedFilesystem;
  }

  initialize(filesystem: LocalRuntimeFilesystemPort): void {
    this.initializedFilesystem = createLocalExecutionFilesystem(filesystem);
  }

  filesystem(
    state: Pick<TransparentBackendState, "filesystem"> | null | undefined,
  ): TransparentBackendFilesystemPort {
    return state?.filesystem ?? this.localFilesystem;
  }

  isWorkspaceFilesystem(filesystem: TransparentBackendFilesystemPort): boolean {
    return this.ctx.runtimeWorkspace.isWorkspaceFilesystem(filesystem);
  }

  defaultFilesystem(): TransparentBackendFilesystemPort {
    return this.ctx.runtimeWorkspace.defaultFilesystem(
      this.localFilesystem,
    ) as TransparentBackendFilesystemPort;
  }

  filesystemForCwd(cwd: string | null): TransparentBackendFilesystemPort | null {
    return this.ctx.runtimeWorkspace.filesystemForCwd(
      cwd,
      this.localFilesystem,
    ) as TransparentBackendFilesystemPort | null;
  }

  filesystemForRealm(realm: "workspace" | "localhost"): TransparentBackendFilesystemPort {
    return this.ctx.runtimeWorkspace.filesystemForRealm(
      realm,
      this.localFilesystem,
    ) as TransparentBackendFilesystemPort;
  }

  backendKey(
    ownerUserId: string,
    filesystem: TransparentBackendFilesystemPort,
    viewId = "main",
  ): string {
    const realm = this.isWorkspaceFilesystem(filesystem) ? "workspace" : "localhost";
    return `${ownerUserId}\0${realm}\0${realm === "workspace" ? viewId : "local"}`;
  }

  threadBackendKey(
    ownerUserId: string,
    filesystem: TransparentBackendFilesystemPort,
    viewId: string,
    outerThreadId: string,
    executionProfile: Partial<ExecutionProfile> | null = null,
  ): string {
    const realm = this.isWorkspaceFilesystem(filesystem) ? "workspace" : "localhost";
    return threadRuntimeBackendKey(
      ownerUserId,
      realm,
      viewId,
      outerThreadId,
      executionProfile,
    );
  }

  stateForOuter(outerThreadId: string): TransparentBackendState | null {
    return this.ctx.transparentRuntimeLocator.stateForOuter(
      outerThreadId,
      this.localFilesystem,
    );
  }

  toInner(
    message: JsonRpcRequest,
    state: TransparentBackendState | null | undefined,
  ): JsonRpcRequest;
  toInner(
    message: JsonRpcResponse,
    state: TransparentBackendState | null | undefined,
  ): JsonRpcResponse;
  toInner(
    message: JsonRpcRequest | JsonRpcResponse,
    state: TransparentBackendState | null | undefined,
  ): JsonRpcRequest | JsonRpcResponse {
    return this.ctx.transparentProtocolMapper.toInner(
      message,
      state,
      this.filesystem(state),
    ) as JsonRpcRequest | JsonRpcResponse;
  }

  toOuter(
    message: JsonRpcRequest,
    state: TransparentBackendState | null | undefined,
  ): JsonRpcRequest;
  toOuter(
    message: JsonRpcResponse,
    state: TransparentBackendState | null | undefined,
  ): JsonRpcResponse;
  toOuter(
    message: JsonRpcRequest | JsonRpcResponse,
    state: TransparentBackendState | null | undefined,
  ): JsonRpcRequest | JsonRpcResponse {
    return this.ctx.transparentProtocolMapper.toOuter(
      message,
      state,
      this.filesystem(state),
    ) as JsonRpcRequest | JsonRpcResponse;
  }

  toPhysical(
    path: string,
    state: TransparentBackendState | null | undefined,
  ): string {
    return this.ctx.transparentProtocolMapper.toPhysical(
      path,
      state,
      this.filesystem(state),
    );
  }

  toVirtual(
    path: string,
    state: TransparentBackendState | null | undefined,
  ): string {
    return this.ctx.transparentProtocolMapper.toVirtual(
      String(path),
      state,
      this.filesystem(state),
    );
  }
}
