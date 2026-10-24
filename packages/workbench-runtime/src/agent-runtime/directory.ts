import type {
  AppServerMethod,
  AppServerMethodParams,
  AppServerMethodResult,
} from "@opencraft/appserver-protocol";

import type { HostRuntimeRegistry } from "../host-runtime-registry";
import type {
  AgentRuntimeAccess,
  AgentRuntimeSession,
  AgentRuntimeSnapshot,
} from "./contract";

type Registry = HostRuntimeRegistry<AgentRuntimeSession>;

const BOOTSTRAPPING = (hostId: string): AgentRuntimeSnapshot => Object.freeze({
  hostId,
  phase: "bootstrapping",
  error: null,
});

/**
 * Application-owned readiness and protocol boundary for Agent runtimes.
 *
 * It deliberately does not own Host registration, transports, Threads, or
 * domain state. Those remain with HostRuntimeRegistry and the runtime itself.
 */
export class AgentRuntimeDirectory implements AgentRuntimeAccess {
  private registry: Registry | null = null;
  private terminalError: Error | null = null;
  private readonly registryWaiters = new Set<{
    readonly resolve: (registry: Registry) => void;
    readonly reject: (error: Error) => void;
  }>();
  private readonly listeners = new Set<() => void>();

  bindRegistry(registry: Registry): void {
    if (this.registry !== null || this.terminalError !== null) {
      throw new Error("Agent Runtime directory is already settled");
    }
    this.registry = registry;
    for (const waiter of this.registryWaiters) waiter.resolve(registry);
    this.registryWaiters.clear();
    this.publish();
  }

  markUnavailable(error: Error): void {
    if (this.registry !== null || this.terminalError !== null) {
      throw new Error("Agent Runtime directory is already settled");
    }
    this.terminalError = error;
    for (const waiter of this.registryWaiters) waiter.reject(error);
    this.registryWaiters.clear();
    this.publish();
  }

  getSnapshot(hostId: string): AgentRuntimeSnapshot {
    if (this.registry === null) {
      return this.terminalError === null
        ? BOOTSTRAPPING(hostId)
        : Object.freeze({ hostId, phase: "error", error: this.terminalError });
    }
    const runtime = this.registry.peekRuntime(hostId);
    if (runtime === null) return Object.freeze({ hostId, phase: "idle", error: null });
    const snapshot = runtime.getSnapshot();
    return Object.freeze({ hostId, phase: snapshot.phase, error: snapshot.error });
  }

  subscribe(hostId: string, listener: () => void): () => void {
    let runtime = this.registry?.peekRuntime(hostId) ?? null;
    let stopRuntime = runtime?.subscribe(listener) ?? null;
    let stopRegistry: (() => void) | null = null;
    const refresh = () => {
      if (stopRegistry === null && this.registry !== null) {
        stopRegistry = this.registry.subscribe(refresh);
      }
      const nextRuntime = this.registry?.peekRuntime(hostId) ?? null;
      if (nextRuntime !== runtime) {
        stopRuntime?.();
        runtime = nextRuntime;
        stopRuntime = runtime?.subscribe(listener) ?? null;
      }
      listener();
    };
    this.listeners.add(refresh);
    if (this.registry !== null) stopRegistry = this.registry.subscribe(refresh);
    return () => {
      stopRegistry?.();
      stopRuntime?.();
      this.listeners.delete(refresh);
    };
  }

  async ensureReady(hostId: string): Promise<AgentRuntimeSession> {
    const registry = await this.waitForRegistry();
    return registry.ensureConnected(hostId);
  }

  async request<TMethod extends AppServerMethod>(
    hostId: string,
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
  ): Promise<AppServerMethodResult<TMethod>> {
    const runtime = await this.ensureReady(hostId);
    return runtime.resources.protocol.request(method, params);
  }

  private waitForRegistry(): Promise<Registry> {
    if (this.registry !== null) return Promise.resolve(this.registry);
    if (this.terminalError !== null) return Promise.reject(this.terminalError);
    return new Promise((resolve, reject) => {
      this.registryWaiters.add({ resolve, reject });
    });
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
