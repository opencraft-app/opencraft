import {
  PERSONAL_MACHINES_METHOD,
  parsePersonalMachinesDirectory,
  type PersonalMachineCommand,
  type PersonalMachinesDirectory,
  type PersonalMachinesMethodMap,
} from "@opencraft/appserver-protocol";
import {
  environmentIdentity,
  type EnvironmentEntry,
  type EnvironmentSource,
  type EnvironmentSourceSnapshot,
  type HostConnectionProfile,
} from "@opencraft/workbench-runtime";

export type PersonalMachineCommandResult = PersonalMachinesMethodMap["opencraft/personal-machines"]["result"];

export interface PersonalMachinesController {
  getDirectorySnapshot(): PersonalMachinesDirectory | null;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  command(input: PersonalMachineCommand): Promise<PersonalMachineCommandResult>;
}

const POLL_INTERVAL_MS = 5_000;

export interface PersonalMachineEnvironmentSourceOptions {
  readonly request: (command: PersonalMachineCommand) => Promise<unknown>;
  readonly resolveRpcUrl: (machineId: string) => string;
  readonly isActive?: () => boolean;
  readonly pollIntervalMs?: number;
}

function isMethodUnsupportedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly rpcCode?: unknown; readonly message?: unknown };
  if (candidate.code === -32601 || candidate.rpcCode === -32601) return true;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return /personal machine enrollment is unavailable|method not found|not supported/iu.test(message);
}

function toEnvironmentEntry(
  sourceId: string,
  machine: PersonalMachinesDirectory["machines"][number],
  resolveRpcUrl: (machineId: string) => string,
): EnvironmentEntry {
  const displayName = machine.machine?.name || machine.name || machine.id;
  const profile: HostConnectionProfile = Object.freeze({
    hostId: `personal:${machine.id}`,
    displayName,
    providerId: "opencraft.websocket",
    providerConfig: Object.freeze({ url: resolveRpcUrl(machine.id) }),
    providerConfigVersion: 1,
    hostKind: "remote-control",
    enabled: true,
    autoConnect: false,
    includeInSidebar: true,
    credentialRef: null,
    transportEndpoint: null,
    executionLocation: displayName,
    workspaceBrowseRoots: Object.freeze([]),
    revision: 1,
    machineIdentity: machine.machine,
    machinePresence: machine.connected ? "online" : "offline",
    agent: "OpenCraft",
  });
  return Object.freeze({
    id: environmentIdentity(sourceId, machine.id),
    sourceId,
    name: displayName,
    location: displayName,
    resource: null,
    connectable: true,
    profile,
  });
}

/**
 * First-class `EnvironmentSource` bridging the deployment Host's personal
 * machine ledger into `EnvironmentDirectory` -> `WorkInMachine` without saving
 * ephemeral relay recipes into IndexedDB.
 */
export class PersonalMachineEnvironmentSource implements EnvironmentSource, PersonalMachinesController {
  readonly id = "opencraft.personal-machines";
  readonly label = "Personal machines";
  // Empty providerIds keeps manually configured WebSocket profiles untouched.
  readonly providerIds: readonly string[] = Object.freeze([]);

  private readonly listeners = new Set<() => void>();
  private directory: PersonalMachinesDirectory | null = null;
  private directorySignature = "";
  private snapshot: EnvironmentSourceSnapshot = Object.freeze({
    revision: 0,
    phase: "loading",
    entries: Object.freeze([]),
    error: null,
  });
  private unsupported = false;
  private disposed = false;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: PersonalMachineEnvironmentSourceOptions) {}

  getSnapshot = (): EnvironmentSourceSnapshot => this.snapshot;

  getDirectorySnapshot = (): PersonalMachinesDirectory | null => this.directory;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  matchProfile(profile: HostConnectionProfile): string | null {
    if (!profile.hostId.startsWith("personal:")) return null;
    const id = profile.hostId.slice("personal:".length);
    return /^[0-9a-f-]{36}$/iu.test(id) ? environmentIdentity(this.id, id) : null;
  }

  start(): void {
    if (this.disposed || this.unsupported) return;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.unsupported) return;
    if (this.inFlight) return this.inFlight;
    const task = (async () => {
      try {
        const raw = await this.options.request({ action: "list" });
        if (this.disposed) return;
        this.applyDirectory(parsePersonalMachinesDirectory(raw));
      } catch (error) {
        if (this.disposed) return;
        if (isMethodUnsupportedError(error)) {
          this.unsupported = true;
          this.directory = null;
          this.publishSource("ready", [], null, true);
          return;
        }
        // Retain the last known directory projection across transient disconnects.
        if (this.directory === null) {
          this.publishSource("error", [], error instanceof Error ? error.message : "Machine directory unavailable", false);
        }
      } finally {
        this.inFlight = null;
        this.scheduleNextPoll();
      }
    })();
    this.inFlight = task;
    return task;
  }

  async command(input: PersonalMachineCommand): Promise<PersonalMachineCommandResult> {
    if (this.disposed) throw new Error("Personal machine source is closed");
    const raw = await this.options.request(input);
    const parsed = parsePersonalMachinesDirectory(raw);
    const extra = raw as { command?: unknown; machineId?: unknown };
    this.unsupported = false;
    this.applyDirectory(parsed);
    this.scheduleNextPoll();
    return {
      ...parsed,
      ...(typeof extra.command === "string" ? { command: extra.command } : {}),
      ...(typeof extra.machineId === "string" ? { machineId: extra.machineId } : {}),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  private scheduleNextPoll(): void {
    if (this.disposed || this.unsupported) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const interval = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.unsupported) return;
      if (this.options.isActive && !this.options.isActive()) {
        this.scheduleNextPoll();
        return;
      }
      void this.refresh();
    }, interval);
  }

  private applyDirectory(next: PersonalMachinesDirectory): void {
    const nextSignature = JSON.stringify(next);
    const directoryChanged = nextSignature !== this.directorySignature;
    this.directory = next;
    this.directorySignature = nextSignature;
    const entries = next.machines
      .filter((machine) => machine.phase === "enrolled" && machine.machine !== null)
      .map((machine) => toEnvironmentEntry(this.id, machine, this.options.resolveRpcUrl));
    this.publishSource("ready", entries, null, directoryChanged);
  }

  private publishSource(
    phase: EnvironmentSourceSnapshot["phase"],
    entries: readonly EnvironmentEntry[],
    error: string | null,
    forceNotify: boolean,
  ): void {
    const prev = this.snapshot;
    const sameSource =
      prev.phase === phase
      && prev.error === error
      && JSON.stringify(prev.entries) === JSON.stringify(entries);
    if (!sameSource) {
      this.snapshot = Object.freeze({
        revision: prev.revision + 1,
        phase,
        entries: Object.freeze([...entries]),
        error,
      });
    }
    if (!sameSource || forceNotify) {
      for (const listener of this.listeners) listener();
    }
  }
}

export { PERSONAL_MACHINES_METHOD };
