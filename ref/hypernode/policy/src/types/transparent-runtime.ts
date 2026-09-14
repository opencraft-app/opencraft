import type { TransparentBindingState } from "./transparent-binding.ts";

export interface StartupRuntimeRecord {
  runtimeId: string;
  outerThreadId?: string;
  processId: string;
  realm?: string;
  viewId: string;
}

export interface RuntimeRegistryRecordInput {
  runtimeId: string;
  outerThreadId?: string;
  processId: string;
  realm?: string;
  viewId: string;
  engineKind?: string;
  ownerUserId?: string;
  startedAtMs?: number;
}

export interface RuntimeRegistryPort {
  register(input: RuntimeRegistryRecordInput): unknown;
  unregister(runtimeId: string): boolean;
  clearView(viewId: string): boolean;
  snapshot(): StartupRuntimeRecord[];
}

export interface TransparentRuntimeRecoveryHost {
  bindingState: TransparentBindingState;
  artifacts: {
    current(threadId: string): { epoch?: number | null | undefined } | null;
  };
  executionEpochs: {
    seedEpoch(threadId: string, epoch: number): unknown;
  };
  runtimeRegistry: {
    snapshot(): StartupRuntimeRecord[];
    unregister(runtimeId: string): boolean;
    clearView(viewId: string): boolean;
  };
  workspaceRuntime: {
    readonly enabled: boolean;
    readonly supportsPersistentRuntimeFencing: boolean;
    terminateThreadRuntime(
      processId: string,
      viewId: string,
      runtimeId: string,
      timeoutMs: number,
    ): unknown;
  };
  threads: {
    list(options: { archived: boolean }): Array<{ id: string }>;
    isTransparentCodex(threadId: string): boolean;
    reconcileInterruptedRuntime(threadId: string): unknown;
  };
}

export interface TransparentRuntimeRecoveryState {
  failures: Map<string, unknown>;
}

export interface TransparentRuntimeRecoveryPort extends TransparentRuntimeRecoveryState {
  clearFailure(threadId: string): void;
}
