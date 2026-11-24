import { randomBytes } from "node:crypto";
import {
  dueOwnerWork,
  periodicOwnerWork,
  timeoutOwnerWake,
  type DueOwnerWork,
  type OwnerWake,
  type PeriodicOwnerWork,
} from "@opencraft/owner-wake";
import type { SandboxBrowserOwnerTransport } from "@opencraft/local-agent-host/sandbox-browser-owner";
import type { OrdinaryExecutionBinding } from "@opencraft/local-agent-host/ordinary-conversation-owner";
import type { WorkspaceActorAdmission } from "./actor-authority.js";
import type { WorkspaceTerminalLease } from "./terminal-transports.js";
export type WorkspaceBrowserStatus =
  { state: "opening" } | { state: "failed" } | { state: "ready"; inventory: unknown[]; workerPid: number };
export interface WorkspaceBrowserPort {
  workspaceBrowserOpen(
    access: WorkspaceActorAdmission,
    threadId: string,
    lease: WorkspaceTerminalLease,
  ): Promise<string>;
  workspaceBrowserStatus(token: string): Promise<WorkspaceBrowserStatus>;
  workspaceBrowserRead(token: string, after: number): Promise<{ frames: { sequence: number; message: unknown }[] }>;
  workspaceBrowserSend(token: string, sequence: number, message: unknown): Promise<void>;
  workspaceBrowserSent(token: string, sequence: number): Promise<"pending" | "sent" | "failed">;
  workspaceBrowserForget(token: string, sequence: number): Promise<void>;
  workspaceBrowserClose(token: string): Promise<"pending" | "closed" | "failed">;
}
const invalid = () => Error("Workspace browser unavailable");
/** A channel untouched this long is closed. */
export const BROWSER_CHANNEL_IDLE_MS = 30_000;
/** Authority and binding currency have no change notification; open channels are re-checked this often. */
export const BROWSER_CHANNEL_CHECK_MS = 100;
const shape = (token: unknown): token is string => typeof token === "string" && /^[a-f0-9]{64}$/u.test(token);
const bytes = (value: unknown, max: number) => {
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > max) throw invalid();
  return size;
};
interface Channel {
  access: WorkspaceActorAdmission;
  threadId: string;
  lease: WorkspaceTerminalLease;
  binding?: OrdinaryExecutionBinding;
  peer?: SandboxBrowserOwnerTransport;
  status: WorkspaceBrowserStatus;
  closed: boolean;
  cleanupFailed: boolean;
  touched: number;
  open: Promise<void>;
  closing?: Promise<void>;
  frames: { sequence: number; message: unknown; bytes: number }[];
  bytes: number;
  last: number;
  ack: number;
  delivered: number;
  nextSend: number;
  sends: Map<number, "pending" | "sent" | "failed">;
  writes: Set<Promise<void>>;
  remove?: () => void;
}
/** Worker-owned bounded protocol custody, not another Browser Owner/page store.
 * No media/result is silently dropped and no command is replayed. Overflow or
 * uncertain write retires the channel; central reconciliation retains custody. */
export class WorkspaceBrowserTransfers {
  private readonly channels = new Map<string, Channel>();
  private queuedBytes = 0;
  private closed = false;
  private readonly wake: OwnerWake;
  /** Idle channels close when the least recently touched one expires; nothing wakes while no channel is open. */
  private readonly idle: DueOwnerWork;
  /** Armed only while a channel is open (its phase starts with the first one). */
  private check: PeriodicOwnerWork | null = null;
  constructor(
    private readonly options: {
      current(access: WorkspaceActorAdmission, pending: boolean): boolean;
      binding(access: WorkspaceActorAdmission, threadId: string): Promise<OrdinaryExecutionBinding>;
      /** Owner wake-up for the authority check and idle expiry; the default Node timeout one. */
      wake?: OwnerWake;
    },
  ) {
    this.wake = options.wake ?? timeoutOwnerWake();
    this.idle = dueOwnerWork(
      this.wake,
      () => {
        let oldest: number | null = null;
        for (const channel of this.channels.values())
          if (!channel.closing && (oldest === null || channel.touched < oldest)) oldest = channel.touched;
        return oldest === null ? null : oldest + BROWSER_CHANNEL_IDLE_MS;
      },
      (now) => {
        for (const [token, channel] of this.channels)
          if (!channel.closing && now - channel.touched >= BROWSER_CHANNEL_IDLE_MS) void this.close(token).catch(() => {});
      },
    );
  }
  /** Re-arms the authority check and idle expiry after a channel opens or closes. Touching a channel only moves its
   * expiry later, so it needs no re-arm: an early wake-up finds nothing due and re-arms for the new time. */
  private changed() {
    const open = !this.closed && [...this.channels.values()].some((channel) => !channel.closing);
    if (open)
      this.check ??= periodicOwnerWork(this.wake, BROWSER_CHANNEL_CHECK_MS, () => {
        for (const [token, channel] of this.channels)
          if (!channel.closing && !this.current(channel)) void this.close(token).catch(() => {});
        this.changed();
      });
    else {
      this.check?.close();
      this.check = null;
    }
    this.idle.reschedule();
  }
  private current(channel: Channel): boolean {
    try {
      if (this.closed || channel.closed || !this.options.current(channel.access, false)) return false;
      if (channel.binding) {
        if (channel.binding.isCurrent?.() !== true || !channel.binding.browser) return false;
        channel.binding.browser.assertCurrent();
      }
      return true;
    } catch {
      return false;
    }
  }
  private lookup(token: string): Channel {
    if (!shape(token)) throw invalid();
    const channel = this.channels.get(token);
    if (!channel) throw invalid();
    return channel;
  }
  private get(token: string): Channel {
    const channel = this.lookup(token);
    if (!this.current(channel)) throw invalid();
    channel.touched = this.wake.now();
    return channel;
  }
  open(access: WorkspaceActorAdmission, threadId: string, lease: WorkspaceTerminalLease): string {
    if (
      this.closed ||
      this.channels.size >= 64 ||
      !this.options.current(access, true) ||
      typeof threadId !== "string" ||
      !threadId ||
      threadId.length > 512 ||
      !lease ||
      Object.keys(lease).some((k) => !["workspaceId", "generation"].includes(k)) ||
      typeof lease.workspaceId !== "string" ||
      lease.workspaceId.length > 512 ||
      !Number.isSafeInteger(lease.generation) ||
      lease.generation < 1
    )
      throw invalid();
    const token = randomBytes(32).toString("hex"),
      channel: Channel = {
        access,
        threadId,
        lease: { ...lease },
        status: { state: "opening" },
        closed: false,
        cleanupFailed: false,
        touched: this.wake.now(),
        open: undefined!,
        frames: [],
        bytes: 0,
        last: 0,
        ack: 0,
        delivered: 0,
        nextSend: 0,
        sends: new Map(),
        writes: new Set(),
      };
    this.channels.set(token, channel);
    this.changed();
    channel.open = (async () => {
      try {
        const binding = await this.options.binding(access, threadId);
        channel.binding = binding;
        const selection = await binding.executionSelection?.();
        if (
          !this.current(channel) ||
          selection?.kind !== "bound" ||
          selection.workspaceId !== lease.workspaceId ||
          selection.generation !== lease.generation ||
          !binding.browser
        )
          throw invalid();
        const peer = await binding.browser.connect();
        channel.peer = peer;
        if (
          !this.current(channel) ||
          !peer.connected ||
          peer.automationCancellation !== 1 ||
          peer.automationNavigation !== 1 ||
          !Array.isArray(peer.inventory) ||
          peer.inventory.length > 1024 ||
          !Number.isSafeInteger(peer.workerPid) ||
          peer.workerPid < 1
        )
          throw invalid();
        bytes(peer.inventory, 32 * 1024 ** 2);
        const lost = () => {
          channel.status = { state: "failed" };
          void this.close(token).catch(() => {});
        };
        const receive = (message: unknown) => {
          try {
            if (!this.current(channel)) throw invalid();
            const size = bytes(message, 32 * 1024 ** 2);
            if (
              channel.frames.length >= 64 ||
              channel.bytes + size > 32 * 1024 ** 2 ||
              this.queuedBytes + size > 64 * 1024 ** 2
            )
              throw invalid();
            channel.frames.push({ sequence: ++channel.last, message: structuredClone(message), bytes: size });
            channel.bytes += size;
            this.queuedBytes += size;
          } catch {
            lost();
          }
        };
        peer.on("message", receive);
        peer.on("exit", lost);
        peer.on("error", lost);
        channel.remove = () => {
          peer.on("error", () => {});
          peer.off("message", receive);
          peer.off("exit", lost);
          peer.off("error", lost);
        };
        channel.status = { state: "ready", inventory: structuredClone(peer.inventory), workerPid: peer.workerPid };
      } catch {
        channel.status = { state: "failed" };
      }
    })();
    // Failed opening is settled outside FIFO; detach even a late SDK attachment.
    void channel.open.then(() => {
      if (channel.status.state === "failed") void this.close(token).catch(() => {});
    });
    return token;
  }
  private async validate(channel: Channel) {
    if (
      !this.current(channel) ||
      !channel.binding ||
      (await this.options.binding(channel.access, channel.threadId)) !== channel.binding
    )
      throw invalid();
  }
  async status(token: string): Promise<WorkspaceBrowserStatus> {
    const channel = this.lookup(token);
    if (!this.current(channel)) return { state: "failed" };
    channel.touched = this.wake.now();
    if (channel.status.state === "ready") await this.validate(channel);
    return channel.status;
  }
  async read(token: string, after: number): Promise<{ frames: { sequence: number; message: unknown }[] }> {
    const channel = this.get(token);
    await this.validate(channel);
    if (
      channel.status.state !== "ready" ||
      !Number.isSafeInteger(after) ||
      after < channel.ack ||
      after > channel.delivered
    )
      throw invalid();
    while (channel.frames[0] && channel.frames[0].sequence <= after) {
      const frame = channel.frames.shift()!;
      channel.bytes -= frame.bytes;
      this.queuedBytes -= frame.bytes;
    }
    channel.ack = after;
    const frames: { sequence: number; message: unknown }[] = [];
    let total = 0;
    for (const frame of channel.frames) {
      if (frames.length >= 8 || (frames.length && total + frame.bytes > 4 * 1024 ** 2)) break;
      frames.push({ sequence: frame.sequence, message: frame.message });
      total += frame.bytes;
    }
    if (frames.length) channel.delivered = Math.max(channel.delivered, frames.at(-1)!.sequence);
    return { frames };
  }
  send(token: string, sequence: number, message: unknown) {
    const channel = this.get(token);
    if (
      channel.status.state !== "ready" ||
      !channel.peer ||
      channel.sends.size >= 128 ||
      !Number.isSafeInteger(sequence) ||
      sequence !== channel.nextSend ||
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      typeof (message as { id?: unknown }).id !== "string"
    )
      throw invalid();
    bytes(message, 256 * 1024);
    const snapshot = structuredClone(message);
    channel.nextSend++;
    channel.sends.set(sequence, "pending");
    const work = new Promise<void>((resolve) => {
      try {
        channel.peer!.send(snapshot, (error) => {
          channel.sends.set(sequence, error ? "failed" : "sent");
          resolve();
        });
      } catch {
        channel.sends.set(sequence, "failed");
        resolve();
      }
    });
    channel.writes.add(work);
    void work.then(() => {
      channel.writes.delete(work);
      if (channel.sends.get(sequence) === "failed") {
        channel.status = { state: "failed" };
        void this.close(token).catch(() => {});
      }
    });
  }
  sent(token: string, sequence: number): "pending" | "sent" | "failed" {
    const channel = this.lookup(token);
    const status = channel.sends.get(sequence);
    if (!status) throw invalid();
    return status;
  }
  forget(token: string, sequence: number) {
    const channel = this.lookup(token);
    if (channel.sends.get(sequence) === "pending") throw invalid();
    channel.sends.delete(sequence);
  }
  requestClose(token: string): "pending" | "closed" | "failed" {
    if (!shape(token)) throw invalid();
    const channel = this.channels.get(token);
    if (!channel) return "closed";
    if (channel.cleanupFailed) return "failed";
    void this.close(token).catch(() => {});
    return "pending";
  }
  close(token: string): Promise<void> {
    if (!shape(token)) return Promise.reject(invalid());
    const channel = this.channels.get(token);
    if (!channel) return Promise.resolve();
    if (channel.closing) return channel.closing;
    channel.closing = (async () => {
      channel.closed = true;
      channel.remove?.();
      await channel.open;
      channel.remove?.();
      try {
        await channel.peer?.close();
        await Promise.all([...channel.writes]);
      } catch {
        channel.cleanupFailed = true;
        throw Error("Workspace browser detach unconfirmed");
      }
      this.queuedBytes -= channel.bytes;
      channel.bytes = 0;
      channel.frames = [];
      this.channels.delete(token);
    })();
    this.changed();
    return channel.closing;
  }
  async closeAll() {
    this.closed = true;
    this.idle.close();
    this.changed();
    const results = await Promise.allSettled([...this.channels.keys()].map((token) => this.close(token)));
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length) throw new AggregateError(failures, "Workspace browser detach unconfirmed");
  }
}
