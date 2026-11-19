import {
  JsonRpcAppServerClient,
  type DuplexTransport,
  type AppServerClientRequestOptions,
} from "@opencraft/appserver-client";
import { ActorInboxClient } from "@opencraft/appserver-client/collaboration";
import {
  CHANNELS_CHANGED,
  CHANNELS_EXTENSION,
  CHANNELS_HOST_ID,
  type ChannelsMethodMap,
  type PersonalAssistantMethodMap,
} from "@opencraft/appserver-protocol";
import type { ChannelRpc } from "@opencraft/plugin-im";

import { exponentialBackoffMs } from "@opencraft/workbench-runtime/retry-schedule";
/** One authenticated Server lifetime owns the Inbox. Views share the transport
 * and consume its replica; server notifications are invalidation hints only. */
type PeopleMethodMap = ChannelsMethodMap & PersonalAssistantMethodMap;
export function createChannelsRpc(transport: DuplexTransport, signal: AbortSignal): ChannelRpc {
  const client = new JsonRpcAppServerClient({ hostId: CHANNELS_HOST_ID, transport });
  let inbox: ActorInboxClient | undefined;
  let supportsGroupLifecycle = false;
  let supportsRead = false;
  let supportsAttachments = false;
  let supportsAttachmentChunks = false;
  let closed = false;
  let authorityError: Error | undefined;
  let inboxRefresh: Promise<void> | undefined;
  let inboxProjection = "";
  let inboxRetry: ReturnType<typeof setTimeout> | undefined;
  let inboxFailures = 0;
  const directorySubscriptions = new Set<string>();
  const changedListeners = new Set<(id: string) => void>();
  const notifyDirectory = () => {
    for (const id of [...directorySubscriptions])
      for (const listener of [...changedListeners]) {
        try {
          listener(id);
        } catch {
          /* One View cannot starve its peers. */
        }
      }
  };
  const refreshInbox = () => {
    if (!inbox || inboxRefresh || closed || authorityError) return;
    clearTimeout(inboxRetry);
    inboxRetry = undefined;
    inboxRefresh = inbox
      .refresh()
      .then(
        () => {
          if (closed || signal.aborted) return;
          inboxFailures = 0;
          const next = JSON.stringify(inbox!.items);
          if (next !== inboxProjection) {
            inboxProjection = next;
            notifyDirectory();
          }
        },
        (error) => {
          if (!closed && !signal.aborted && [401, 403].includes(error?.status)) {
            authorityError = new Error("channel_denied");
            notifyDirectory();
          } else if (!closed && !signal.aborted) {
            inboxRetry = setTimeout(
              refreshInbox,
              exponentialBackoffMs(inboxFailures++, { initialMs: 1_000, maxMs: 30_000 }),
            );
          }
          // The authenticated RPC lifetime owns a single bounded read-only retry.
        },
      )
      .finally(() => {
        inboxRefresh = undefined;
      });
  };
  let draftScope: string | undefined;
  const close = async () => {
    closed = true;
    clearTimeout(inboxRetry);
    inbox?.close();
    directorySubscriptions.clear();
    changedListeners.clear();
    await client.close();
  };
  signal.addEventListener(
    "abort",
    () => {
      void close();
    },
    { once: true },
  );
  return {
    get supportsGroupLifecycle() {
      return supportsGroupLifecycle;
    },
    get supportsAttachmentChunks() {
      return supportsAttachmentChunks;
    },
    get draftScope() {
      return draftScope;
    },
    get supportsAttachments() {
      return supportsAttachments;
    },
    get supportsRead() {
      return supportsRead;
    },
    async connect() {
      if (authorityError) throw authorityError;
      if (closed || signal.aborted) throw Error("Channels closed");
      const initialized = await client.connect({ clientInfo: { name: "opencraft", version: "1" } }, signal);
      const capability = initialized.capabilities?.extensions?.[CHANNELS_EXTENSION];
      if (!capability || typeof capability !== "object" || !("version" in capability) || capability.version !== 1) {
        throw new Error("Unsupported channels protocol");
      }
      const scope =
        "authority" in capability &&
        typeof capability.authority === "string" &&
        capability.authority.length > 0 &&
        "actorId" in capability &&
        typeof capability.actorId === "string" &&
        capability.actorId.length > 0
          ? JSON.stringify([capability.authority, capability.actorId])
          : undefined;
      if (draftScope !== undefined && draftScope !== scope) {
        draftScope = undefined;
        await close();
        throw Error("Channel identity changed");
      }
      draftScope = scope;
      supportsGroupLifecycle = "groupLifecycle" in capability && capability.groupLifecycle === 1;
      supportsAttachments = "attachments" in capability && capability.attachments === 1;
      supportsAttachmentChunks = "attachmentChunks" in capability && capability.attachmentChunks === 1;
      supportsRead = "read" in capability && capability.read === true;
      if (
        "inbox" in capability &&
        capability.inbox === 1 &&
        "actorId" in capability &&
        typeof capability.actorId === "string"
      ) {
        if (inbox && inbox.actorId !== capability.actorId) {
          await close();
          throw Error("Channel identity changed");
        }
        inbox ??= new ActorInboxClient(capability.actorId, {
          async sync(cursor, requestSignal) {
            try {
              return await client.request("opencraft/inbox/sync", { cursor }, { signal: requestSignal });
            } catch (error) {
              if (
                error instanceof Error &&
                ["channel_denied", "actor_authentication_required"].includes(error.message)
              ) {
                throw Object.assign(error, { status: 401 });
              }
              throw error;
            }
          },
        });
      }
    },
    async request<M extends keyof PeopleMethodMap>(
      method: M,
      params: PeopleMethodMap[M]["params"],
      requestSignal?: AbortSignal,
      options?: Pick<AppServerClientRequestOptions, "timeoutMs" | "onSendProgress" | "sendProgressSignal">,
    ): Promise<PeopleMethodMap[M]["result"]> {
      if (authorityError) throw authorityError;
      const result = await client.request(method, params, { ...options, signal: requestSignal });
      if (authorityError) throw authorityError;
      if (method === "opencraft/channels/subscribe") {
        const subscription = params as ChannelsMethodMap["opencraft/channels/subscribe"]["params"];
        if (subscription.channelId === undefined) directorySubscriptions.add(subscription.subscriptionId);
      } else if (method === "opencraft/channels/unsubscribe") {
        directorySubscriptions.delete(
          (params as ChannelsMethodMap["opencraft/channels/unsubscribe"]["params"]).subscriptionId,
        );
      }
      if (method === "opencraft/channels/list" && inbox) {
        refreshInbox();
        if (closed || signal.aborted || requestSignal?.aborted) throw Error("Channels closed");
        const rows = new Map(inbox.items.map((item) => [item.channelId, item]));
        const directory = result as ChannelsMethodMap["opencraft/channels/list"]["result"];
        return {
          groups: directory.groups.map((group) => {
            const item = rows.get(group.id);
            return item
              ? {
                  ...group,
                  unreadCount: item.unreadCount,
                  mentionUnreadCount: item.mentionUnreadCount ?? 0,
                  firstUnreadMentionSequence: item.firstUnreadMentionSequence,
                  latestMessage: item.latestMessage,
                }
              : group;
          }),
        } as PeopleMethodMap[M]["result"];
      }
      return result;
    },
    onChanged: (listener) => {
      changedListeners.add(listener);
      const remove = client.subscribeNotification(({ method, params }) => {
        if (
          method === CHANNELS_CHANGED &&
          params &&
          typeof params === "object" &&
          "subscriptionId" in params &&
          typeof params.subscriptionId === "string"
        )
          listener(params.subscriptionId);
      });
      return () => {
        changedListeners.delete(listener);
        remove();
      };
    },
    onRecoveryHint: (listener) =>
      transport.subscribeRecoveryHint?.(() => {
        if (!closed && !signal.aborted && !authorityError) listener();
      }) ?? (() => {}),
    onDisconnect: (listener) =>
      client.subscribeStatus(({ state }) => {
        if (state === "closed" || state === "failed") listener();
      }),
    close,
  };
}
