import type { JsonRpcRequest, JsonRpcResponse } from "./appserver.ts";
import type {
  TransparentBackendFilesystemPort,
  TransparentBackendState,
} from "./transparent-backend.ts";
import type { LocalRuntimeFilesystemPort } from "./workspace.ts";
import type { ExecutionProfile } from "../services/execution-profile.ts";

export interface TransparentRuntimeAccessPort {
  readonly localFilesystem: TransparentBackendFilesystemPort;
  initialize(filesystem: LocalRuntimeFilesystemPort): void;
  filesystem(
    state: Pick<TransparentBackendState, "filesystem"> | null | undefined,
  ): TransparentBackendFilesystemPort;
  isWorkspaceFilesystem(filesystem: TransparentBackendFilesystemPort): boolean;
  defaultFilesystem(): TransparentBackendFilesystemPort;
  filesystemForCwd(cwd: string | null): TransparentBackendFilesystemPort | null;
  filesystemForRealm(realm: "workspace" | "localhost"): TransparentBackendFilesystemPort;
  backendKey(
    ownerUserId: string,
    filesystem: TransparentBackendFilesystemPort,
    viewId?: string,
  ): string;
  threadBackendKey(
    ownerUserId: string,
    filesystem: TransparentBackendFilesystemPort,
    viewId: string,
    outerThreadId: string,
    executionProfile?: Partial<ExecutionProfile> | null,
  ): string;
  stateForOuter(outerThreadId: string): TransparentBackendState | null;
  toInner(
    message: JsonRpcRequest,
    state: TransparentBackendState | null | undefined,
  ): JsonRpcRequest;
  toInner(
    message: JsonRpcResponse,
    state: TransparentBackendState | null | undefined,
  ): JsonRpcResponse;
  toOuter(
    message: JsonRpcRequest,
    state: TransparentBackendState | null | undefined,
  ): JsonRpcRequest;
  toOuter(
    message: JsonRpcResponse,
    state: TransparentBackendState | null | undefined,
  ): JsonRpcResponse;
  toPhysical(
    path: string,
    state: TransparentBackendState | null | undefined,
  ): string;
  toVirtual(
    path: string,
    state: TransparentBackendState | null | undefined,
  ): string;
}
