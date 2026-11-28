export const DEFAULT_DESKTOP_POWER_SAVE_GRACE_MS = 60_000;
export const DEFAULT_DESKTOP_POWER_SAVE_MAX_SILENCE_MS = 30 * 60_000;

export interface PowerSaveBlockerPort {
  start(): number;
  stop(id: number): void;
}

export interface DesktopPowerSaveCoordinatorOptions {
  readonly graceMs?: number;
  readonly maxSilenceMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const LOCAL_DAEMON_HOSTS: ReadonlySet<string> = new Set(["local", "local-codex"]);
const LIFECYCLE_FRAME_HINT = /"(?:turn\/(?:started|completed)|thread\/(?:status\/changed|closed|archived|deleted))"/u;

function isWaitingOnlyFlags(flags: unknown): boolean {
  return (
    Array.isArray(flags) &&
    flags.length > 0 &&
    flags.every((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
  );
}

/**
 * Coordinates Electron `powerSaveBlocker.start("prevent-app-suspension")` across
 * attached local daemon bridges so active local turns keep macOS, Windows, and
 * Linux awake without preventing display sleep or leaking across idle sessions.
 */
export class DesktopPowerSaveCoordinator {
  private readonly graceMs: number;
  private readonly maxSilenceMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private readonly activeThreads = new Set<string>();
  private blockerId: number | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastActivityAtMs = 0;
  private closed = false;

  constructor(
    private readonly blocker: PowerSaveBlockerPort,
    options: DesktopPowerSaveCoordinatorOptions = {},
  ) {
    this.graceMs = options.graceMs ?? DEFAULT_DESKTOP_POWER_SAVE_GRACE_MS;
    this.maxSilenceMs = options.maxSilenceMs ?? DEFAULT_DESKTOP_POWER_SAVE_MAX_SILENCE_MS;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return timer;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  get activeCount(): number {
    return this.activeThreads.size;
  }

  get isBlocking(): boolean {
    return this.blockerId !== null;
  }

  observeDaemonPayload(bridgeId: number, payload: unknown): void {
    if (this.closed || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const message = payload as Record<string, unknown>;
    if (message.type === "fatal") {
      this.releaseBridge(bridgeId);
      return;
    }
    const hostId = message.hostId;
    if (typeof hostId !== "string" || !LOCAL_DAEMON_HOSTS.has(hostId)) return;

    if (message.type === "host/status") {
      const status = message.status;
      if (status && typeof status === "object" && !Array.isArray(status)) {
        const state = (status as Record<string, unknown>).state;
        if (state === "closed" || state === "failed") {
          this.releaseScope(`${bridgeId}\0${hostId}\0`);
        }
      }
      return;
    }

    if (message.type !== "host/frame" || typeof message.frame !== "string") return;
    const rawFrame = message.frame;

    if (this.activeThreads.size > 0) {
      this.lastActivityAtMs = this.now();
      if (this.blockerId === null) this.ensureBlocking();
    }
    if (!LIFECYCLE_FRAME_HINT.test(rawFrame)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFrame);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const rpc = parsed as Record<string, unknown>;
    if ("id" in rpc && rpc.id !== undefined) return;
    const method = rpc.method;
    const params = rpc.params;
    if (typeof method !== "string" || !params || typeof params !== "object" || Array.isArray(params)) return;
    const threadId = (params as Record<string, unknown>).threadId;
    if (typeof threadId !== "string" || !threadId) return;

    const key = `${bridgeId}\0${hostId}\0${threadId}`;
    switch (method) {
      case "turn/started":
        this.markActive(key);
        break;
      case "turn/completed":
      case "thread/closed":
      case "thread/archived":
      case "thread/deleted":
        this.markInactive(key);
        break;
      case "thread/status/changed": {
        const status = (params as Record<string, unknown>).status;
        if (!status || typeof status !== "object" || Array.isArray(status)) break;
        const statusRecord = status as Record<string, unknown>;
        if (statusRecord.type === "active") {
          if (isWaitingOnlyFlags(statusRecord.activeFlags)) this.markInactive(key);
          else this.markActive(key);
        } else if (
          statusRecord.type === "idle" ||
          statusRecord.type === "notLoaded" ||
          statusRecord.type === "systemError"
        ) {
          this.markInactive(key);
        }
        break;
      }
      default:
        break;
    }
  }

  releaseBridge(bridgeId: number): void {
    this.releaseScope(`${bridgeId}\0`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.activeThreads.clear();
    this.cancelGraceTimer();
    this.cancelSilenceTimer();
    this.stopBlocking();
  }

  private releaseScope(prefix: string): void {
    if (this.closed) return;
    let changed = false;
    for (const key of [...this.activeThreads]) {
      if (key.startsWith(prefix)) {
        this.activeThreads.delete(key);
        changed = true;
      }
    }
    if (changed && this.activeThreads.size === 0) {
      this.cancelSilenceTimer();
      this.scheduleGraceRelease();
    }
  }

  private markActive(key: string): void {
    this.activeThreads.add(key);
    this.lastActivityAtMs = this.now();
    this.cancelGraceTimer();
    this.ensureBlocking();
    this.scheduleSilenceCheck();
  }

  private markInactive(key: string): void {
    if (!this.activeThreads.delete(key)) return;
    if (this.activeThreads.size === 0) {
      this.cancelSilenceTimer();
      this.scheduleGraceRelease();
    }
  }

  private ensureBlocking(): void {
    if (this.closed || this.blockerId !== null) return;
    this.blockerId = this.blocker.start();
    this.scheduleSilenceCheck();
  }

  private stopBlocking(): void {
    const id = this.blockerId;
    this.blockerId = null;
    if (id !== null) this.blocker.stop(id);
  }

  private scheduleGraceRelease(): void {
    if (this.blockerId === null || this.graceTimer !== undefined) return;
    if (this.graceMs <= 0) {
      this.stopBlocking();
      return;
    }
    this.graceTimer = this.setTimer(() => {
      this.graceTimer = undefined;
      if (this.activeThreads.size === 0) this.stopBlocking();
    }, this.graceMs);
  }

  private scheduleSilenceCheck(): void {
    if (this.maxSilenceMs <= 0 || this.activeThreads.size === 0 || this.blockerId === null) return;
    this.cancelSilenceTimer();
    const elapsed = Math.max(0, this.now() - this.lastActivityAtMs);
    const remaining = Math.max(1, this.maxSilenceMs - elapsed);
    this.silenceTimer = this.setTimer(() => {
      this.silenceTimer = undefined;
      if (this.closed || this.activeThreads.size === 0 || this.blockerId === null) return;
      if (this.now() - this.lastActivityAtMs >= this.maxSilenceMs) {
        this.stopBlocking();
      } else {
        this.scheduleSilenceCheck();
      }
    }, remaining);
  }

  private cancelGraceTimer(): void {
    if (this.graceTimer !== undefined) {
      this.clearTimer(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  private cancelSilenceTimer(): void {
    if (this.silenceTimer !== undefined) {
      this.clearTimer(this.silenceTimer);
      this.silenceTimer = undefined;
    }
  }
}
