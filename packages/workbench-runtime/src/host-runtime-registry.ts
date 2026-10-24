import type { RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import type { AppServerHostKind } from "@opencraft/appserver-session";

import type { AppServerWorkbenchRuntime } from "./appserver-runtime";

export interface HostRuntimeLifecycle {
  /** Idempotently establishes the physical Host connection. */
  connect(): Promise<void>;
  dispose(): Promise<void>;
}

export interface HostRuntimeDescriptor {
  readonly machineIdentity?: RuntimeMachineIdentity | null;
  readonly hostId: string;
  readonly label: string;
  readonly kind: AppServerHostKind;
  /** Physical Renderer-to-AppServer endpoint. Never presented as a workspace. */
  readonly transportEndpoint: string | null;
  /** User-facing execution location (machine, SSH alias, or durable region). */
  readonly executionLocation: string | null;
  /** Server-advertised roots the directory picker is allowed to enter. */
  readonly workspaceBrowseRoots: readonly string[];
}

export interface HostRuntimeRegistration<TRuntime extends HostRuntimeLifecycle> {
  descriptor: HostRuntimeDescriptor;
  readonly createRuntime: () => TRuntime;
}

export interface HostRuntimeRegistrySnapshot {
  readonly revision: number;
  readonly hosts: readonly HostRuntimeDescriptor[];
}

interface HostRuntimeRecord<TRuntime extends HostRuntimeLifecycle> {
  readonly registrationGeneration: number;
  descriptor: HostRuntimeDescriptor;
  readonly createRuntime: () => TRuntime;
  runtime: TRuntime | null;
  connectOperation: Promise<TRuntime> | null;
  disposeOperation: Promise<void> | null;
  removed: boolean;
}

/**
 * Application owner for complete Host runtimes. A Host switch changes the
 * active execution namespace; it never mutates the identity of an existing
 * runtime, Thread or Replica.
 */
export class HostRuntimeRegistry<
  TRuntime extends HostRuntimeLifecycle = AppServerWorkbenchRuntime,
> {
  private readonly records = new Map<string, HostRuntimeRecord<TRuntime>>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private registrationGeneration = 0;
  private disposed = false;
  private snapshot: HostRuntimeRegistrySnapshot;

  constructor(
    registrations: readonly HostRuntimeRegistration<TRuntime>[] = [],
  ) {
    for (const registration of registrations) {
      this.insert(registration);
    }
    this.snapshot = this.createSnapshot();
  }

  getSnapshot = (): HostRuntimeRegistrySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Adds an application-owned Host factory. Registering a Host does not create
   * its runtime or establish a physical connection.
   */
  register(registration: HostRuntimeRegistration<TRuntime>): void {
    this.ensureOpen();
    this.insert(registration);
    this.publish();
  }

  getRegistrationGeneration(hostId: string): number | null {
    return this.records.get(hostId)?.registrationGeneration ?? null;
  }

  recordMachineIdentity(hostId: string, machineIdentity: RuntimeMachineIdentity | null): void {
    const record = this.records.get(hostId);
    if (!record || record.removed || this.disposed) return;
    record.descriptor = Object.freeze({ ...record.descriptor, machineIdentity });
    this.publish();
  }

  has(hostId: string): boolean {
    return this.records.has(hostId);
  }

  /**
   * Returns an already-created runtime without creating or connecting one.
   * Ownership checks use this to inspect background work before removing a
   * Host; observation must never become an implicit connection side effect.
   */
  peekRuntime(hostId: string): TRuntime | null {
    this.ensureOpen();
    const record = this.records.get(hostId);
    if (record === undefined || record.removed) return null;
    return record.runtime;
  }

  getRuntime(hostId: string): TRuntime {
    this.ensureOpen();
    const record = this.records.get(hostId);
    if (record === undefined) throw new Error(`Unknown Host runtime ${hostId}`);
    if (record.removed) throw new Error(`Host runtime ${hostId} is being removed`);
    if (record.runtime === null) {
      record.runtime = record.createRuntime();
      // Let passive observers attach to a newly created Runtime.
      this.publish();
    }
    return record.runtime;
  }

  ensureConnected(hostId: string): Promise<TRuntime> {
    this.ensureOpen();
    const record = this.records.get(hostId);
    if (record === undefined) return Promise.reject(new Error(`Unknown Host runtime ${hostId}`));
    if (record.removed) return Promise.reject(new Error(`Host runtime ${hostId} is being removed`));
    if (record.connectOperation !== null) return record.connectOperation;
    const runtime = this.getRuntime(hostId);
    const operation = runtime.connect()
      .then(() => {
        if (this.disposed) {
          throw new Error(`Host runtime ${hostId} was disposed during connection`);
        }
        if (record.removed || this.records.get(hostId) !== record) {
          throw new Error(`Host runtime ${hostId} was removed during connection`);
        }
        return runtime;
      })
      .finally(() => {
        if (record.connectOperation === operation) record.connectOperation = null;
      });
    record.connectOperation = operation;
    return operation;
  }

  /**
   * Detaches a Host before disposing its runtime. New lookups therefore fail
   * synchronously while an in-flight connect is fenced by record identity.
   */
  async remove(hostId: string): Promise<boolean> {
    this.ensureOpen();
    const record = this.records.get(hostId);
    if (record === undefined) return false;
    record.removed = true;
    this.records.delete(hostId);
    this.publish();
    await this.disposeRecord(record);
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const records = [...this.records.values()];
    this.records.clear();
    for (const record of records) record.removed = true;
    this.listeners.clear();
    const results = await Promise.allSettled(records.map((record) => this.disposeRecord(record)));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to dispose one or more Host runtimes");
    }
  }

  private ensureOpen(): void {
    if (this.disposed) throw new Error("Host runtime registry is disposed");
  }

  private insert(registration: HostRuntimeRegistration<TRuntime>): void {
    const hostId = registration.descriptor.hostId.trim();
    if (hostId.length === 0) throw new RangeError("Host ID must not be empty");
    if (this.records.has(hostId)) throw new Error(`Duplicate Host runtime ${hostId}`);
    this.records.set(hostId, {
      registrationGeneration: ++this.registrationGeneration,
      descriptor: Object.freeze({ ...registration.descriptor, hostId }),
      createRuntime: registration.createRuntime,
      runtime: null,
      connectOperation: null,
      disposeOperation: null,
      removed: false,
    });
  }

  private disposeRecord(record: HostRuntimeRecord<TRuntime>): Promise<void> {
    if (record.disposeOperation !== null) return record.disposeOperation;
    if (record.runtime === null) return Promise.resolve();
    const operation = Promise.resolve(record.runtime.dispose()).finally(() => {
      record.connectOperation = null;
    });
    record.disposeOperation = operation;
    return operation;
  }

  private publish(): void {
    this.revision += 1;
    this.snapshot = this.createSnapshot();
    for (const listener of this.listeners) listener();
  }

  private createSnapshot(): HostRuntimeRegistrySnapshot {
    return {
      revision: this.revision,
      hosts: [...this.records.values()].map((record) => record.descriptor),
    };
  }
}
