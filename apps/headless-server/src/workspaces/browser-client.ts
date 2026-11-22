import { EventEmitter } from "node:events";
import type { SandboxBrowserOwnerTransport } from "@opencraft/local-agent-host/sandbox-browser-owner";
import type { WorkspaceActorAdmission } from "./actor-authority.js";
import type { WorkspaceTerminalLease } from "./terminal-transports.js";
import type { WorkspaceBrowserPort } from "./browser-transports.js";
const pause = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const unavailable = () =>
  Object.assign(Error("Workspace browser unavailable"), {
    code: "BROWSER_UNAVAILABLE",
    retryable: false,
    outcome: "unknown",
  });
async function closeToken(port: WorkspaceBrowserPort, token: string) {
  for (;;) {
    const status = await port.workspaceBrowserClose(token);
    if (status === "closed") return;
    if (status === "failed") throw Error("Workspace browser detach unconfirmed");
    await pause();
  }
}
/** Protocol adapter only. The Worker still owns the SDK/lease/browser connection;
 * a failed send has unknown outcome and is never resubmitted by this transport. */
export class WorkspaceBrowserClient extends EventEmitter implements SandboxBrowserOwnerTransport {
  connected = true;
  readonly automationCancellation = 1;
  readonly automationNavigation = 1;
  private stopped = false;
  private sequence = 0;
  private cursor = 0;
  private pumping: Promise<void> | undefined;
  private readonly writes = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  private constructor(
    private readonly options: { port: WorkspaceBrowserPort; token: string; authorize(): void },
    readonly inventory: unknown[],
    readonly workerPid: number,
  ) {
    super();
    this.on("newListener", (event) => {
      if (event === "message" && !this.pumping && !this.stopped)
        queueMicrotask(() => {
          if (this.pumping || this.stopped) return;
          this.pumping = this.pump().catch(() => this.retire());
        });
    });
  }
  static async open(options: {
    port: WorkspaceBrowserPort;
    access: WorkspaceActorAdmission;
    threadId: string;
    lease: WorkspaceTerminalLease;
    authorize(): void;
  }): Promise<WorkspaceBrowserClient> {
    options.authorize();
    const token = await options.port.workspaceBrowserOpen(options.access, options.threadId, options.lease);
    try {
      for (;;) {
        options.authorize();
        const status = await options.port.workspaceBrowserStatus(token);
        options.authorize();
        if (status.state === "failed") throw unavailable();
        if (status.state === "ready")
          return new WorkspaceBrowserClient({ ...options, token }, status.inventory, status.workerPid);
        await pause();
      }
    } catch (cause) {
      await closeToken(options.port, token);
      throw cause;
    }
  }
  private retire() {
    if (this.stopped) return;
    this.stopped = true;
    this.connected = false;
    this.emit("exit");
    void this.close().catch(() => {});
  }
  private async pump() {
    while (!this.stopped) {
      this.options.authorize();
      const { frames } = await this.options.port.workspaceBrowserRead(this.options.token, this.cursor);
      this.options.authorize();
      for (const frame of frames) {
        if (this.stopped) return;
        if (!Number.isSafeInteger(frame.sequence) || frame.sequence !== this.cursor + 1) throw unavailable();
        this.options.authorize();
        this.emit("message", frame.message);
        this.cursor = frame.sequence;
      }
      if (!frames.length) await pause(50);
    }
  }
  send(message: unknown, callback?: (error?: Error) => void): void {
    let snapshot: unknown;
    try {
      if (
        this.stopped ||
        !message ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        typeof (message as { id?: unknown }).id !== "string" ||
        Buffer.byteLength(JSON.stringify(message)) > 256 * 1024 ||
        this.writes.size >= 128
      )
        throw unavailable();
      this.options.authorize();
      snapshot = structuredClone(message);
    } catch {
      callback?.(unavailable());
      return;
    }
    const sequence = this.sequence++;
    const work = (async () => {
      await this.options.port.workspaceBrowserSend(this.options.token, sequence, snapshot);
      for (;;) {
        if (this.stopped) throw unavailable();
        this.options.authorize();
        const status = await this.options.port.workspaceBrowserSent(this.options.token, sequence);
        this.options.authorize();
        if (status === "failed") throw unavailable();
        if (status === "sent") break;
        await pause();
      }
      await this.options.port.workspaceBrowserForget(this.options.token, sequence);
    })();
    this.writes.add(work);
    void work
      .then(
        () => {
          try {
            callback?.();
          } catch {
            /* Delivery observer is not authority. */
          }
        },
        () => {
          try {
            callback?.(unavailable());
          } finally {
            this.retire();
          }
        },
      )
      .finally(() => this.writes.delete(work))
      .catch(() => {});
  }
  kill() {
    void this.close().catch(() => {});
  }
  close(): Promise<void> {
    return (this.closing ??= Promise.resolve().then(async () => {
      const notify = !this.stopped;
      this.stopped = true;
      this.connected = false;
      if (notify) this.emit("exit");
      // Closing the peer resolves pending write callbacks; do not wait for writes
      // first or a stalled provider flush could deadlock its own cancellation.
      await closeToken(this.options.port, this.options.token);
      await Promise.allSettled([...this.writes]);
    }));
  }
}
