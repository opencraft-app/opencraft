import type { TransparentBackendState } from "./transparent-backend.ts";
import type { RuntimeFilesystemPort } from "./workspace.ts";

export type TransparentProtocolRuntimeState = Pick<
  TransparentBackendState,
  "backendKey" | "opening" | "user" | "viewId"
>;

export interface TransparentProtocolThread {
  id: string;
  cwd?: string | null;
  name?: string | null;
  preview?: string | null;
  [key: string]: unknown;
}

export interface TransparentProtocolThreadManagerPort {
  find(threadId: string): TransparentProtocolThread | null;
  isRoot(threadId: string): boolean;
  isTransparentCodex(threadId: string): boolean;
  metadataFor(threadId: string): {
    kind?: string | null;
    ownerPrincipalId?: string | null;
  } | null;
  ownerOf(threadId: string): string | null;
  promoteToTransparentCodex(threadId: string): boolean;
}

/**
 * Stable AppServer namespace projection for a replaceable execution Runtime.
 *
 * The outer Thread ID and virtual paths are public protocol identities. Inner
 * Thread IDs and physical paths belong only to one Runtime generation.
 */
export interface TransparentProtocolMapperPort {
  outerThreadId(
    innerThreadId: string,
    state?: TransparentProtocolRuntimeState | null,
  ): string | null;
  toInner(
    message: unknown,
    state: TransparentProtocolRuntimeState | null | undefined,
    filesystem: RuntimeFilesystemPort,
  ): unknown;
  toOuter(
    message: unknown,
    state: TransparentProtocolRuntimeState | null | undefined,
    filesystem: RuntimeFilesystemPort,
  ): unknown;
  toPhysical(
    path: string,
    state: TransparentProtocolRuntimeState | null | undefined,
    filesystem: RuntimeFilesystemPort,
  ): string;
  toVirtual(
    path: string,
    state: TransparentProtocolRuntimeState | null | undefined,
    filesystem: RuntimeFilesystemPort,
  ): string;
  enforceThreadNames(value: unknown): unknown;
}
