import type { AppServerClientRequestOptions } from "@opencraft/appserver-client";
import { AttachmentChunkDeadline, combineAbortSignals } from "@opencraft/appserver-client/transport";
import type {
  ChannelHistoryPage,
  ChannelMessage,
  ChannelSyncPage,
  ChannelsMethodMap,
  PersonalAssistantMethodMap,
} from "@opencraft/appserver-protocol";
import { ImClient, ImHttpError } from "./client";
import { normalizeChannelAttachment, channelAttachmentFailure } from "./channel-attachment-file";

type ChannelSendOptions = Pick<
  ChannelsMethodMap["opencraft/channels/messages/send"]["params"],
  "replyToMessageId" | "wakeActorIds" | "mentions"
>;

export type PeopleMethodMap = ChannelsMethodMap & PersonalAssistantMethodMap;
export interface ChannelRpc {
  readonly supportsGroupLifecycle?: boolean;
  readonly supportsAttachmentChunks?: boolean;
  readonly draftScope?: string;
  readonly supportsRead?: boolean;
  readonly supportsAttachments?: boolean;
  connect(): Promise<void>;
  request<M extends keyof PeopleMethodMap>(
    method: M,
    params: PeopleMethodMap[M]["params"],
    signal?: AbortSignal,
    options?: Pick<AppServerClientRequestOptions, "timeoutMs" | "onSendProgress" | "sendProgressSignal">,
  ): Promise<PeopleMethodMap[M]["result"]>;
  onChanged(listener: (subscriptionId: string) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  /** Shared transport foreground/route hints; not another socket or retry owner. */
  onRecoveryHint?(listener: () => void): () => void;
  close(): Promise<void>;
}

export class ChannelsClient extends ImClient {
  constructor(
    fetcher: typeof fetch,
    private readonly rpc: ChannelRpc,
  ) {
    super(fetcher);
  }

  private async command<M extends keyof ChannelsMethodMap>(
    method: M,
    params: ChannelsMethodMap[M]["params"],
    signal: AbortSignal,
    options?: Pick<AppServerClientRequestOptions, "timeoutMs" | "onSendProgress" | "sendProgressSignal">,
  ) {
    try {
      signal.throwIfAborted();
      await this.connected(signal);
      return await this.rpc!.request(method, params, signal, options);
    } catch (error) {
      if (error instanceof Error && error.message === "channel_denied") throw new ImHttpError(error.message, 403);
      throw error;
    }
  }

  private async connected(signal: AbortSignal) {
    signal.throwIfAborted();
    // A View's deadline retires only its wait, not the shared connection.
    let aborted: (() => void) | undefined;
    try {
      await Promise.race([
        this.rpc.connect(),
        new Promise<never>((_, reject) => {
          aborted = () => reject(signal.reason ?? new Error("Channel request aborted"));
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        }),
      ]);
    } finally {
      if (aborted) signal.removeEventListener("abort", aborted);
    }
    signal.throwIfAborted();
  }

  async markRead(channelId: string, throughSequence: number, signal: AbortSignal) {
    if (!this.rpc || !/^(dm:|group:)/.test(channelId)) return;
    await this.connected(signal);
    if (this.rpc.supportsRead) await this.command("opencraft/channels/read", { channelId, throughSequence }, signal);
  }

  async assistantStatus(signal: AbortSignal) {
    await this.connected(signal);
    signal.throwIfAborted();
    return this.rpc.request("opencraft/personal-assistant/get", {}, signal);
  }

  delivery(channelId: string, clientMessageId: string, signal: AbortSignal) {
    return this.command("opencraft/channels/delivery/get", { channelId, clientMessageId }, signal);
  }

  acknowledgeMention(channelId: string, messageId: string, signal: AbortSignal) {
    return this.command("opencraft/channels/mentions/ack", { channelId, messageId }, signal);
  }
  around(channelId: string, sequence: number, signal: AbortSignal) {
    return this.command("opencraft/channels/messages/around", { channelId, sequence }, signal);
  }
  search(query: string, before: number | undefined, signal: AbortSignal) {
    return this.command("opencraft/channels/search", { query, before }, signal);
  }
  group(channelId: string, signal: AbortSignal) {
    return this.command("opencraft/channels/group/get", { channelId }, signal);
  }
  setGroupHidden(channelId: string, hidden: boolean, clientRequestId: string, signal: AbortSignal) {
    return this.command("opencraft/channels/group/list-state/set", { channelId, hidden, clientRequestId }, signal);
  }
  leaveGroup(channelId: string, clientRequestId: string, signal: AbortSignal) {
    return this.command("opencraft/channels/group/leave", { channelId, clientRequestId }, signal);
  }
  dissolveGroup(channelId: string, expectedRevision: number, clientRequestId: string, signal: AbortSignal) {
    return this.command("opencraft/channels/group/dissolve", { channelId, expectedRevision, clientRequestId }, signal);
  }
  list(signal: AbortSignal) {
    return this.command("opencraft/channels/list", {}, signal);
  }
  history(channelId: string, before: number, signal: AbortSignal) {
    return this.command("opencraft/channels/messages/list", { channelId, before }, signal);
  }
  sync(channelId: string, cursor: string | undefined, signal: AbortSignal): Promise<ChannelSyncPage> {
    return this.command("opencraft/channels/sync", { channelId, cursor }, signal);
  }
  sendText(
    channelId: string,
    clientMessageId: string,
    text: string,
    signal: AbortSignal,
    options?: ChannelSendOptions,
  ) {
    return this.sendWithReceipt(channelId, clientMessageId, signal, () =>
      this.command(
        "opencraft/channels/messages/send",
        { channelId, clientMessageId, parts: [{ type: "text", text }], ...options },
        signal,
      ),
    );
  }

  async sendChannelAttachment(
    channelId: string,
    clientMessageId: string,
    file: File,
    signal: AbortSignal,
    text?: string,
    onProgress?: (confirmed: number, total: number) => void,
  ) {
    // Also normalize restored/older drafts and non-Composer callers at the transport boundary.
    const prepared = await normalizeChannelAttachment(file, signal);
    try {
      return await this.sendPreparedAttachment(channelId, clientMessageId, prepared, signal, text, onProgress);
    } catch (error) {
      throw channelAttachmentFailure(error, prepared);
    }
  }

  private async sendPreparedAttachment(
    channelId: string,
    clientMessageId: string,
    file: File,
    signal: AbortSignal,
    text?: string,
    onProgress?: (confirmed: number, total: number) => void,
  ) {
    await this.connected(signal);
    if (!this.rpc.supportsAttachmentChunks) {
      // Legacy endpoints have no replay contract. Keep small-file compatibility,
      // but do not queue an unbounded frame that blocks every shared operation.
      if (file.size > 64 * 1024) throw Error("channel_chunk_upload_unavailable");
      const bytes = new Uint8Array(await file.arrayBuffer());
      signal.throwIfAborted();
      const base64 = btoa(String.fromCharCode(...bytes));
      return this.sendWithReceipt(channelId, clientMessageId, signal, () =>
        this.command(
          "opencraft/channels/attachments/send",
          {
            channelId,
            clientMessageId,
            name: file.name,
            type: file.type || "application/octet-stream",
            base64,
            ...(text ? { text } : {}),
          },
          signal,
        ),
      );
    }
    onProgress?.(0, file.size);
    return this.sendWithReceipt(channelId, clientMessageId, signal, async () => {
      for (let offset = 0; ; ) {
        signal.throwIfAborted();
        const bytes = new Uint8Array(await file.slice(offset, offset + 64 * 1024).arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const params = {
          channelId,
          clientMessageId,
          name: file.name,
          type: file.type || "application/octet-stream",
          total: file.size,
          offset,
          base64: btoa(binary),
          ...(text ? { text } : {}),
        };
        let result: ChannelsMethodMap["opencraft/channels/attachments/upload"]["result"] | undefined;
        for (let attempt = 0; !result; attempt++) {
          signal.throwIfAborted();
          await this.connected(signal);
          if (!this.rpc.supportsAttachmentChunks) throw Error("channel_chunk_upload_unavailable");
          const deadline = new AttachmentChunkDeadline(params.base64.length, offset + bytes.length === file.size);
          const wait = combineAbortSignals([signal, deadline.signal]);
          try {
            result = await this.command("opencraft/channels/attachments/upload", params, wait.signal, {
              timeoutMs: 0,
              onSendProgress: (progress) => deadline.observe(progress),
              sendProgressSignal: wait.signal,
            });
          } catch (error) {
            const code = deadline.expired ? "TIMEOUT" : (error as { code?: string }).code;
            if (
              signal.aborted ||
              attempt >= 2 ||
              !["TIMEOUT", "DISCONNECTED", "TRANSPORT_ERROR", "CONNECTION_FAILED", "NOT_CONNECTED"].includes(code ?? "")
            )
              throw error;
          } finally {
            wait.dispose();
            deadline.dispose();
          }
        }
        if (result.nextOffset !== offset + bytes.length) throw Error("Invalid channel upload acknowledgement");
        onProgress?.(result.nextOffset, file.size);
        if (result.receipt) return { receipt: result.receipt };
        offset = result.nextOffset;
        if (offset >= file.size) throw Error("Channel upload receipt missing");
      }
    });
  }

  async attachment(channelId: string, sequence: number, signal: AbortSignal): Promise<Blob> {
    await this.connected(signal);
    if (this.rpc.supportsAttachmentChunks) {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let offset = 0,
        metadata: string | undefined;
      for (;;) {
        const part = await this.command("opencraft/channels/attachments/read", { channelId, sequence, offset }, signal);
        if (!part) throw Error("attachment_unavailable");
        const signature = JSON.stringify([part.name, part.type, part.size]);
        if (metadata !== undefined && signature !== metadata) throw Error("Attachment changed during download");
        metadata = signature;
        if (
          !Number.isSafeInteger(part.size) ||
          part.size < 0 ||
          part.size > 20 * 1024 * 1024 ||
          part.base64.length > 87384
        )
          throw Error("Invalid channel download");
        const bytes = Uint8Array.from(atob(part.base64), (c) => c.charCodeAt(0));
        if (
          part.nextOffset !== offset + bytes.length ||
          part.nextOffset > part.size ||
          (bytes.length === 0 && offset !== part.size)
        )
          throw Error("Invalid channel download offset");
        parts.push(bytes);
        offset = part.nextOffset;
        if (offset === part.size) return new Blob(parts, { type: part.type });
      }
    }
    const file = await this.command("opencraft/channels/attachments/get", { channelId, sequence }, signal);
    if (!file) throw Error("attachment_unavailable");
    const binary = atob(file.base64),
      bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: file.type });
  }
  async recordResource(
    channelId: string,
    sequence: number,
    path: string,
    signal: AbortSignal,
  ): Promise<{ name: string; blob: Blob }> {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0,
      metadata: string | undefined;
    for (;;) {
      const part = await this.command(
        "opencraft/channels/records/resource/read",
        { channelId, sequence, path, offset },
        signal,
      );
      if (!part) throw Error("attachment_unavailable");
      const signature = JSON.stringify([part.name, part.type, part.size, part.revision]);
      if (metadata !== undefined && signature !== metadata) throw Error("Attachment changed during download");
      metadata = signature;
      if (
        !Number.isSafeInteger(part.size) ||
        part.size < 1 ||
        part.size > 20 * 1024 * 1024 ||
        part.base64.length > 87384
      )
        throw Error("Invalid record resource");
      const bytes = Uint8Array.from(atob(part.base64), (c) => c.charCodeAt(0));
      if (
        !bytes.length ||
        bytes.length > 65536 ||
        part.nextOffset !== offset + bytes.length ||
        part.nextOffset > part.size
      )
        throw Error("Invalid record resource offset");
      parts.push(bytes);
      offset = part.nextOffset;
      if (offset === part.size) return { name: part.name, blob: new Blob(parts, { type: part.type }) };
    }
  }
  override image(channelId: string, sequence: number, signal: AbortSignal): Promise<Blob> {
    return this.rpc.supportsAttachments
      ? this.attachment(channelId, sequence, signal)
      : super.image(channelId, sequence, signal);
  }
  sendChannelImage(channelId: string, clientMessageId: string, file: File, signal: AbortSignal) {
    return this.sendWithReceipt(channelId, clientMessageId, signal, () =>
      super.sendImage<{ receipt: ChannelMessage }>(channelId, clientMessageId, file, signal),
    );
  }

  private async sendWithReceipt(
    channelId: string,
    clientMessageId: string,
    signal: AbortSignal,
    write: () => Promise<{ receipt: ChannelMessage }>,
  ): Promise<{ receipt: ChannelMessage }> {
    try {
      return await write();
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error &&
          ["idempotency_conflict", "invalid_input", "channel_denied"].includes(error.message)) ||
        (error instanceof ImHttpError && error.status >= 400 && error.status < 500)
      )
        throw error;
      // The ACK may be lost after the native transaction commits. Query the
      // existing delivery authority by the same ID; never replay the write.
      const lookup = combineAbortSignals([signal, AbortSignal.timeout(5000)]);
      try {
        const { receipt } = await this.command(
          "opencraft/channels/delivery/get",
          { channelId, clientMessageId },
          lookup.signal,
        );
        if (receipt && !lookup.signal.aborted) return { receipt };
      } catch {
        /* No authoritative receipt: preserve input and retry identity. */
      } finally {
        lookup.dispose();
      }
      throw error;
    }
  }

  createGroup(title: string, memberActorIds: string[], clientRequestId: string, signal: AbortSignal, wecom = false) {
    return this.command(
      "opencraft/channels/group/create",
      { title, memberActorIds, clientRequestId, ...(wecom ? { wecom: true } : {}) },
      signal,
    );
  }

  rename(channelId: string, title: string, clientRequestId: string, signal: AbortSignal) {
    return this.command("opencraft/channels/group/rename", { channelId, title, clientRequestId }, signal);
  }

  members(channelId: string, signal: AbortSignal) {
    return this.command("opencraft/channels/group/members/list", { channelId }, signal);
  }

  groupSyncStatus(channelId: string, signal: AbortSignal) {
    return this.command("opencraft/channels/group/sync/status", { channelId }, signal);
  }

  refreshGroupSync(channelId: string, clientRequestId: string, signal: AbortSignal) {
    return this.command("opencraft/channels/group/sync/refresh", { channelId, clientRequestId }, signal);
  }

  inviteCandidates(query: string, signal: AbortSignal, channelId?: string) {
    return this.command("opencraft/channels/group/candidates/search", { query, channelId }, signal);
  }

  setMember(channelId: string, actorId: string, present: boolean, clientRequestId: string, signal: AbortSignal) {
    return this.command(
      "opencraft/channels/group/member/set",
      { channelId, actorId, present, clientRequestId },
      signal,
    );
  }

  /** Each connection owns its work. Retirement never waits for an old Promise. */
  watch(
    channelId: string | undefined,
    refresh: (signal: AbortSignal) => Promise<void>,
    onError: (error: unknown) => void,
    signal: AbortSignal,
    options?: { onInvalidate?: () => void; onConnectionLost?: () => void },
  ) {
    const rpc = this.rpc;
    type Flight = {
      owner: AbortController;
      subscriptionId: string;
      subscribed: boolean;
      running: boolean;
      queued: boolean;
      startedAt?: number;
      timer?: ReturnType<typeof setTimeout>;
    };
    const fresh = (): Flight => ({
      owner: new AbortController(),
      subscriptionId: crypto.randomUUID(),
      subscribed: false,
      running: false,
      queued: false,
    });
    let current = fresh(),
      authorityBlocked = false;
    const valid = (flight: Flight) =>
      !authorityBlocked && !signal.aborted && !flight.owner.signal.aborted && flight === current;
    const retire = (flight: Flight) => {
      clearTimeout(flight.timer);
      flight.owner.abort();
      void rpc.request("opencraft/channels/unsubscribe", { subscriptionId: flight.subscriptionId }).catch(() => {});
    };
    const wake = (delay = 0) => {
      const flight = current;
      if (!valid(flight)) return;
      flight.queued = true;
      if (!flight.running && flight.timer === undefined) flight.timer = setTimeout(() => void run(flight), delay);
    };
    const run = async (flight: Flight) => {
      flight.timer = undefined;
      if (!valid(flight)) return;
      flight.queued = false;
      flight.running = true;
      flight.startedAt = Date.now();
      let retry = false;
      try {
        if (!flight.subscribed) {
          await this.command(
            "opencraft/channels/subscribe",
            { channelId, subscriptionId: flight.subscriptionId },
            flight.owner.signal,
          );
          if (!valid(flight)) return;
          flight.subscribed = true;
        }
        await refresh(flight.owner.signal);
      } catch (cause) {
        if (valid(flight)) {
          const error =
            !(cause instanceof ImHttpError) && (await this.accessLost(flight.owner.signal))
              ? new ImHttpError("channel_denied", 403)
              : cause;
          if (!valid(flight)) return;
          authorityBlocked = error instanceof ImHttpError && [401, 403].includes(error.status);
          onError(error);
          retry = !authorityBlocked;
        }
      } finally {
        flight.running = false;
        if (valid(flight)) {
          if (retry) wake(1000);
          else if (flight.queued) wake();
        }
      }
    };
    const unwatch = rpc.onChanged((id) => {
      if (id === current.subscriptionId) {
        options?.onInvalidate?.();
        wake();
      }
    });
    const disconnect = rpc.onDisconnect(() => {
      if (signal.aborted) return;
      retire(current);
      current = fresh();
      options?.onConnectionLost?.();
      options?.onInvalidate?.();
      wake(1000);
    });
    const recover = rpc.onRecoveryHint?.(() => {
      if (signal.aborted || authorityBlocked) return;
      // A page can resume with no close event and an old read that never settled.
      // Retire only this read/subscription; physical recovery stays with AppHost.
      if (current.running && Date.now() - (current.startedAt ?? Date.now()) >= 10_000) {
        retire(current);
        current = fresh();
        options?.onConnectionLost?.();
      }
      options?.onInvalidate?.();
      wake();
    });
    const stop = () => {
      retire(current);
      unwatch();
      disconnect();
      recover?.();
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    else wake();
  }

  private async accessLost(signal: AbortSignal) {
    const request = combineAbortSignals([signal, AbortSignal.timeout(3000)]);
    try {
      const response = await this.fetcher("/__opencraft_im/capabilities", { signal: request.signal });
      if (response.status === 401 || response.status === 403) return true;
      if (!response.ok) return false;
      const capabilities = await response.json();
      return capabilities?.nativeChannels !== true;
    } catch {
      return false;
    } finally {
      request.dispose();
    }
  }
}
