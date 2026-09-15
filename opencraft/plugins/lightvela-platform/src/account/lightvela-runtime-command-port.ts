import type {
  LightVelaDebugCommandChunk,
  LightVelaDebugCommandResult,
} from "./lightvela-account-service";

export interface LightVelaRuntimeCommandOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Optional data-plane command owner injected by the active Agent adapter. */
export interface LightVelaRuntimeCommandPort {
  execIfAvailable(
    instanceId: string,
    command: string,
    onChunk: ((chunk: LightVelaDebugCommandChunk) => void) | undefined,
    options?: LightVelaRuntimeCommandOptions,
  ): Promise<LightVelaDebugCommandResult | null>;
  requestIfAvailable?<TResult>(
    instanceId: string,
    method: string,
    params: unknown,
    options?: LightVelaRuntimeCommandOptions,
  ): Promise<TResult | null>;
}
