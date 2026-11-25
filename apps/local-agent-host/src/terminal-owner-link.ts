import type { PreparedProcessIdentity } from "./process-identity.js";
import {
  encodeTerminalOwnerFrame,
  terminalOwnerFrameReader,
  TERMINAL_OWNER_FRAME_BYTES,
  TERMINAL_OWNER_PROTOCOL,
} from "./terminal-owner-wire.js";

/** A private byte transport. Closing it detaches the Host and leaves the PTYs in Hands. */
export interface TerminalOwnerConnection {
  readonly closed: Promise<unknown>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export class TerminalCapacityError extends Error {
  constructor() {
    super("Terminal limit reached. Close an existing terminal before creating another.");
    this.name = "TerminalCapacityError";
  }
}

export interface TerminalOwnerLink {
  readonly closed: Promise<void>;
  readonly isClosed: boolean;
  readonly terminalAdmission: boolean;
  readonly environmentLaunch: boolean;
  dispatch(
    method: string,
    params: unknown,
    identity: PreparedProcessIdentity,
    assertCurrent?: () => void,
    onAccepted?: () => void,
  ): Promise<unknown>;
  close(): Promise<void>;
}

/** A resource generation settles only after Hands confirms every descendant is gone. */
export async function releaseTerminalThread(
  dispatch: TerminalOwnerLink["dispatch"],
  hostId: string,
  threadId: string,
  activate = false,
  aliases: readonly { owner: string; resourceOwnerId: string }[] = [],
): Promise<void> {
  const deadline = Date.now() + 5000;
  const identity: PreparedProcessIdentity = {
    quotaOwner: "server-lifecycle",
    lifecycleAuthority: true,
    scope: { hostId, threadId, account: null, projectId: null },
  };
  for (;;) {
    const result = await dispatch("process/releaseThread", { aliases }, identity);
    const pending = object(result)?.pending;
    if (pending === 0) {
      if (activate) {
        const receipt = await dispatch("process/releaseThread", { activate: true, aliases }, identity);
        if (object(receipt)?.pending !== 0) throw new Error("Conversation terminal activation unconfirmed");
      }
      return;
    }
    if (typeof pending !== "number" || !Number.isSafeInteger(pending) || pending < 0 || Date.now() >= deadline)
      throw new Error("Conversation terminal cleanup pending");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The Node Gateway and an edge Host use the same attach, request and observation protocol. */
export async function openTerminalOwnerLink(
  dial: (onData: (bytes: Uint8Array) => void) => Promise<TerminalOwnerConnection>,
  options: { token?: string; environmentIssuer?: string; onNotification(method: string, params: unknown): void },
): Promise<TerminalOwnerLink> {
  let connection: TerminalOwnerConnection | undefined;
  let stopping: Promise<void> | undefined;
  let done = false;
  let attachSent = false;
  let attached = false;
  let terminalAdmission = false;
  let environmentLaunch = false;
  let next = 0;
  let queuedBytes = 0;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let accept!: () => void, refuse!: (error: Error) => void, disconnected!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    accept = resolve;
    refuse = reject;
  });
  void ready.catch(() => {});
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const watched = new Set<string>();
  const pending = new Map<
    number,
    {
      accept(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const stop = (error: Error) => {
    if (!done) {
      done = true;
      clearTimeout(handshakeTimer);
      refuse(error);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
      watched.clear();
      disconnected();
    }
    if (connection) return (stopping ??= connection.close());
    return Promise.resolve();
  };
  const lost = (error: Error) => {
    void stop(error).catch(() => {});
  };
  const send = async (frame: Uint8Array) => {
    if (done || !connection) throw new Error("Terminal owner link closed");
    if (queuedBytes + frame.byteLength > TERMINAL_OWNER_FRAME_BYTES)
      throw new Error("Terminal owner send queue exceeds its budget");
    queuedBytes += frame.byteLength;
    try {
      await connection.write(frame);
    } finally {
      queuedBytes -= frame.byteLength;
    }
  };
  const receive = terminalOwnerFrameReader((value) => {
    if (done) return;
    const message = object(value);
    if (!message) throw new Error("Invalid terminal owner message");
    if (!attached) {
      if (!attachSent || message.type !== "attached" || message.protocol !== TERMINAL_OWNER_PROTOCOL)
        throw new Error("Terminal owner protocol incompatible");
      attached = true;
      terminalAdmission = message.terminalAdmission === 1;
      environmentLaunch = !!options.environmentIssuer && message.environmentLaunch === 1;
      clearTimeout(handshakeTimer);
      accept();
      return;
    }
    if (typeof message.method === "string") {
      const handle = object(message.params)?.processHandle;
      if (typeof handle === "string" && watched.has(handle)) {
        if (message.method === "process/exited") watched.delete(handle);
        options.onNotification(message.method, message.params);
      }
      return;
    }
    const id = message.id;
    if (typeof id !== "number") return;
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (message.error)
      request.reject(
        message.error === "capacity"
          ? new TerminalCapacityError()
          : new Error("Terminal unavailable for this account or project"),
      );
    else request.accept(message.result);
  });

  try {
    connection = await dial((bytes) => {
      if (done) return;
      try {
        receive(bytes);
      } catch {
        lost(new Error("Invalid terminal owner frame"));
      }
    });
    if (done) throw new Error("Terminal owner link closed during attach");
    const onDisconnect = () =>
      lost(
        new Error(
          attached ? "Terminal owner disconnected; operation outcome may be unknown" : "Terminal owner attach closed",
        ),
      );
    void connection.closed.then(onDisconnect, onDisconnect);
    handshakeTimer = setTimeout(() => lost(new Error("Terminal owner attach timed out")), 5000);
    attachSent = true;
    void send(
      encodeTerminalOwnerFrame({
        type: "attach",
        protocol: TERMINAL_OWNER_PROTOCOL,
        ...(options.token ? { token: options.token } : {}),
        ...(options.environmentIssuer ? { environmentIssuer: options.environmentIssuer } : {}),
      }),
    ).catch(onDisconnect);
    await ready;
    if (done) throw new Error("Terminal owner link closed during attach");
  } catch (error) {
    await stop(error instanceof Error ? error : new Error("Terminal owner unavailable")).catch(() => {});
    throw error;
  }

  return {
    closed,
    get isClosed() {
      return done;
    },
    terminalAdmission,
    environmentLaunch,
    async dispatch(method, params, identity, assertCurrent, onAccepted) {
      if (done) throw new Error("Terminal owner link closed");
      assertCurrent?.();
      if (pending.size >= 128) throw new Error("Terminal request limit reached");
      const id = ++next;
      const frame = encodeTerminalOwnerFrame({ id, method, params, identity });
      const result = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Terminal operation timed out; outcome may be unknown"));
        }, 15_000);
        pending.set(id, {
          timer,
          reject,
          accept: (value) => {
            try {
              assertCurrent?.();
              onAccepted?.();
              const handle = object(params)?.processHandle;
              if (typeof handle === "string" && method !== "process/kill") {
                if (method === "process/attach" && object(value)?.phase !== "running") watched.delete(handle);
                else watched.add(handle);
              }
              resolve(value);
            } catch (error) {
              reject(error);
            }
          },
        });
      });
      void send(frame).catch(() => lost(new Error("Terminal owner write failed; operation outcome may be unknown")));
      return result;
    },
    close: () => stop(new Error("Terminal owner link closed")),
  };
}
