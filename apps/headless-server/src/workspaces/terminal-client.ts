import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { ProcessSnapshot } from "@opencraft/appserver-protocol";
import type { HostTerminalService } from "../host-terminal-transport.js";
import type { WorkspaceActorAdmission } from "./actor-authority.js";
import type { WorkspaceTerminalPort } from "./terminal-transports.js";
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
/** Stable per Actor/Thread/incarnation. Watches are resource-owned; every new
 * mutation receives its ORIGINAL ingress context, not a mutable last sender.
 * UI detach stops observation, never the separately owned remote processes. */
export class WorkspaceTerminalClient implements HostTerminalService {
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private readonly cursors = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private readonly requests = new Set<WorkspaceActorAdmission>();
  private readonly dispatches = new Set<Promise<unknown>>();
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly options: {
      port: WorkspaceTerminalPort;
      token: string;
      threadId: string;
      actorId: string;
      generation: number;
      admit(context: TransportSubmissionContext): WorkspaceActorAdmission;
      onCleanupUnconfirmed(): void;
    },
  ) {}
  async probe() {
    if (this.stopped) throw Error("Workspace terminal unavailable");
    await this.options.port.workspaceTerminalProbe(this.options.token);
  }
  subscribe(listener: (method: string, params: unknown) => void) {
    if (this.stopped || this.listeners.size >= 128) throw Error("Workspace terminal unavailable");
    this.listeners.add(listener);
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    };
  }
  private emit(method: string, params: unknown) {
    for (const listener of this.listeners)
      try {
        listener(method, params);
      } catch {
        /* Observer cannot acquire another scope. */
      }
  }
  private schedule() {
    if (this.stopped || this.polling || this.timer || !this.listeners.size || !this.cursors.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.polling = this.poll()
        .catch(() => {
          this.stopped = true;
        })
        .finally(() => {
          this.polling = undefined;
          this.schedule();
        });
    }, 50);
    this.timer.unref();
  }
  private async poll() {
    for (const [handle, cursor] of this.cursors) {
      if (this.stopped || !this.listeners.size) return;
      const snapshot = await this.options.port.workspaceTerminalSnapshot(this.options.token, handle, cursor);
      if (this.stopped) return;
      if (snapshot.processHandle !== handle || snapshot.nextSequence < cursor || !Array.isArray(snapshot.output))
        throw Error("Invalid terminal replay");
      for (const chunk of snapshot.output) if (chunk.sequence > cursor) this.emit("process/outputDelta", chunk);
      this.cursors.set(handle, snapshot.nextSequence);
      if (snapshot.phase === "exited") {
        this.emit("process/exited", { processHandle: handle, exitCode: snapshot.exitCode });
        this.cursors.delete(handle);
      }
    }
  }
  readonly dispatch: HostTerminalService["dispatch"] = (...args) => {
    const work = this.run(...args);
    this.dispatches.add(work);
    void work.then(
      () => this.dispatches.delete(work),
      () => this.dispatches.delete(work),
    );
    return work;
  };
  private readonly run: HostTerminalService["dispatch"] = async (
    method,
    params,
    scope,
    assertCurrent,
    onAccepted,
    context,
  ) => {
    if (
      this.stopped ||
      !context ||
      scope?.hostId !== "local-codex" ||
      scope.threadId !== this.options.threadId ||
      scope.projectId !== null
    )
      throw Error("Workspace terminal scope unavailable");
    const check = () => {
      if (this.stopped) throw Error("Workspace terminal retired");
      assertCurrent?.();
      if (
        context.actorContext?.actorId !== this.options.actorId ||
        context.actorContext.generation !== this.options.generation
      )
        throw Error("Workspace terminal Actor changed");
      this.options.admit(context);
    };
    check();
    const access = this.options.admit(context);
    this.requests.add(access);
    let operation: string | undefined,
      settled = false;
    try {
      operation = await this.options.port.workspaceTerminalRequest(this.options.token, access, method, params);
      for (;;) {
        check();
        const value = await this.options.port.workspaceTerminalStatus(operation);
        check();
        if (value.state === "pending") {
          await pause();
          continue;
        }
        settled = true;
        if (value.state === "failed") throw Error("Workspace terminal operation unavailable; do not replay");
        onAccepted?.();
        const handle =
          params && typeof params === "object" && "processHandle" in params ? params.processHandle : undefined;
        if (typeof handle === "string" && ["process/spawn", "process/attach"].includes(method)) {
          const snapshot = value.result as Partial<ProcessSnapshot>;
          this.cursors.set(
            handle,
            method === "process/attach" && typeof snapshot.nextSequence === "number" ? snapshot.nextSequence : 0,
          );
          this.schedule();
        }
        return value.result;
      }
    } finally {
      Atomics.store(access.requestPermit, 0, 0);
      this.requests.delete(access);
      if (operation) {
        const token = operation;
        const cleanup = (async () => {
          if (!settled)
            for (;;) {
              const result = await this.options.port.workspaceTerminalStatus(token);
              if (result.state !== "pending") break;
              await pause();
            }
          await this.options.port.workspaceTerminalForget(token);
        })();
        const safe = cleanup.catch(() => {
          try {
            this.options.onCleanupUnconfirmed();
          } catch {
            /* No observer override. */
          }
        });
        this.pending.add(safe);
        void safe.finally(() => this.pending.delete(safe));
      }
    }
  };
  close() {
    return (this.closing ??= (async () => {
      this.stopped = true;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.listeners.clear();
      this.cursors.clear();
      for (const request of this.requests) Atomics.store(request.requestPermit, 0, 0);
      await this.polling;
      await Promise.allSettled([...this.dispatches]);
      while (this.pending.size) await Promise.all([...this.pending]);
      await this.options.port.workspaceTerminalUnwatch(this.options.token);
    })());
  }
}
