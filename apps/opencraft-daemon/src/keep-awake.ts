import { spawn, type ChildProcess } from "node:child_process";

export const DEFAULT_KEEP_AWAKE_GRACE_MS = 60_000;
export const DEFAULT_KEEP_AWAKE_MAX_SILENCE_MS = 30 * 60_000;

export interface SleepInhibitor {
  /** Start preventing idle system sleep and return an idempotent release handle. */
  acquire(): () => void;
}

export interface TurnActivityKeepAwakeOptions {
  readonly inhibitor?: SleepInhibitor;
  readonly graceMs?: number;
  readonly maxSilenceMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const LIFECYCLE_FRAME_HINT = /"(?:turn\/(?:started|completed)|thread\/(?:status\/changed|closed|archived|deleted))"/u;

function isWaitingOnlyFlags(flags: unknown): boolean {
  return (
    Array.isArray(flags) &&
    flags.length > 0 &&
    flags.every((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
  );
}

/**
 * Default local OS sleep inhibitor for the detached daemon.
 * On macOS, `caffeinate -i -w <pid>` ties the assertion directly to this
 * daemon's PID in the kernel so even a SIGKILL never leaves an orphan lock.
 */
export function createPlatformSleepInhibitor(options?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly pid?: number;
  readonly spawnProcess?: typeof spawn;
}): SleepInhibitor {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const pid = options?.pid ?? process.pid;
  const spawnProcess = options?.spawnProcess ?? spawn;

  if (
    env.OPENCRAFT_KEEP_AWAKE === "0" ||
    (env.NODE_TEST_CONTEXT !== undefined && env.OPENCRAFT_KEEP_AWAKE !== "1") ||
    platform !== "darwin"
  ) {
    return { acquire: () => () => {} };
  }

  return {
    acquire() {
      let child: ChildProcess | null = null;
      let released = false;
      try {
        child = spawnProcess("/usr/bin/caffeinate", ["-i", "-w", String(pid)], {
          stdio: "ignore",
          detached: false,
        });
        child.on("error", () => {
          child = null;
        });
        child.unref();
      } catch {
        child = null;
      }
      return () => {
        if (released) return;
        released = true;
        if (child && child.exitCode === null && !child.killed) {
          try {
            child.kill("SIGTERM");
          } catch {
            // Process already exited.
          }
        }
        child = null;
      };
    },
  };
}

/**
 * Reference-counts active local turns across physical hosts (`local`, `local-codex`)
 * with a cooldown grace window for queued follow-ups and a silence watchdog so
 * an unanswered overnight approval prompt never drains battery indefinitely.
 */
export class TurnActivityKeepAwake {
  private readonly inhibitor: SleepInhibitor;
  private readonly graceMs: number;
  private readonly maxSilenceMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private readonly activeThreads = new Set<string>();
  private releaseBlocker: (() => void) | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastActivityAtMs = 0;
  private closed = false;

  constructor(options: TurnActivityKeepAwakeOptions = {}) {
    this.inhibitor = options.inhibitor ?? createPlatformSleepInhibitor();
    this.graceMs = options.graceMs ?? DEFAULT_KEEP_AWAKE_GRACE_MS;
    this.maxSilenceMs = options.maxSilenceMs ?? DEFAULT_KEEP_AWAKE_MAX_SILENCE_MS;
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
    return this.releaseBlocker !== null;
  }

  observeFrame(hostId: string, rawFrame: string): void {
    if (this.closed) return;
    if (this.activeThreads.size > 0) {
      this.lastActivityAtMs = this.now();
      // Live progress after a silence timeout re-engages protection immediately.
      if (this.releaseBlocker === null) this.ensureBlocking();
    }
    if (!LIFECYCLE_FRAME_HINT.test(rawFrame)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFrame);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const message = parsed as Record<string, unknown>;
    if ("id" in message && message.id !== undefined) return;
    const method = message.method;
    const params = message.params;
    if (typeof method !== "string" || !params || typeof params !== "object" || Array.isArray(params)) return;
    const threadId = (params as Record<string, unknown>).threadId;
    if (typeof threadId !== "string" || !threadId) return;

    const key = `${hostId}\0${threadId}`;
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

  releaseHost(hostId: string): void {
    if (this.closed) return;
    const prefix = `${hostId}\0`;
    let changed = false;
    for (const key of [...this.activeThreads]) {
      if (key.startsWith(prefix)) {
        this.activeThreads.delete(key);
        changed = true;
      }
    }
    if (changed && this.activeThreads.size === 0) this.scheduleGraceRelease();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.activeThreads.clear();
    this.cancelGraceTimer();
    this.cancelSilenceTimer();
    this.stopBlocking();
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
    if (this.closed || this.releaseBlocker !== null) return;
    this.releaseBlocker = this.inhibitor.acquire();
    this.scheduleSilenceCheck();
  }

  private stopBlocking(): void {
    const release = this.releaseBlocker;
    this.releaseBlocker = null;
    release?.();
  }

  private scheduleGraceRelease(): void {
    if (this.releaseBlocker === null || this.graceTimer !== undefined) return;
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
    if (this.maxSilenceMs <= 0 || this.activeThreads.size === 0 || this.releaseBlocker === null) return;
    this.cancelSilenceTimer();
    const elapsed = Math.max(0, this.now() - this.lastActivityAtMs);
    const remaining = Math.max(1, this.maxSilenceMs - elapsed);
    this.silenceTimer = this.setTimer(() => {
      this.silenceTimer = undefined;
      if (this.closed || this.activeThreads.size === 0 || this.releaseBlocker === null) return;
      if (this.now() - this.lastActivityAtMs >= this.maxSilenceMs) {
        // Yield sleep assertion while silent; any subsequent frame re-acquires it.
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
