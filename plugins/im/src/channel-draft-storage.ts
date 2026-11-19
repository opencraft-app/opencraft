import {
  createEmptyComposerDocument,
  isComposerSavedContent,
  type ComposerDraftStorage,
  type ComposerSavedContent,
} from "@opencraft/composer-core";
import type { TrustedExtensionApiV1 } from "@opencraft/extension-runtime";

type StorageApi = NonNullable<TrustedExtensionApiV1["storage"]>;
export type ChannelDraftAttempt = {
  payload: string;
  id: string;
  document: string;
  attachmentId?: string;
  documentAccepted?: boolean;
};
export type ChannelDraftReply = { messageId: string; author: string; text: string };
type Saved = {
  scope: string;
  channelId: string;
  content: ComposerSavedContent | null;
  attempt: ChannelDraftAttempt | null;
  reply: ChannelDraftReply | null;
};
const LIMIT = 256 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
function decode(value: unknown, scope: string, channelId: string): Saved {
  if (
    !object(value) ||
    value.scope !== scope ||
    value.channelId !== channelId ||
    (value.content !== null && !isComposerSavedContent(value.content)) ||
    (value.attempt !== null &&
      (!object(value.attempt) ||
        !text(value.attempt.id, 256) ||
        !text(value.attempt.payload, LIMIT) ||
        !text(value.attempt.document, LIMIT) ||
        (value.attempt.attachmentId !== undefined && !text(value.attempt.attachmentId, 256)) ||
        (value.attempt.documentAccepted !== undefined && typeof value.attempt.documentAccepted !== "boolean"))) ||
    (value.reply !== null &&
      (!object(value.reply) ||
        !text(value.reply.messageId, 256) ||
        !text(value.reply.author, 1024) ||
        !text(value.reply.text, 1024)))
  )
    throw Error("Invalid saved channel draft");
  if (JSON.stringify(value).length > LIMIT) throw Error("Saved channel draft is too large");
  return value as unknown as Saved;
}

/** Local originals only. The authenticated RPC scope selects the record; no
 * browser URL, label, message authors or delivery state grant access to it. */
export async function openChannelDraftStorage(
  api: StorageApi,
  scope: string,
  channelId: string,
  signal: AbortSignal,
  attachmentError: string,
) {
  signal.throwIfAborted();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([scope, channelId])));
  const namespace = "draft." + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  signal.throwIfAborted();
  const document = await api.open(namespace, {
    version: 1,
    initialValue: { scope, channelId, content: null, attempt: null, reply: null },
  });
  const snapshot = await document.read();
  signal.throwIfAborted();
  let saved = decode(snapshot.value, scope, channelId),
    revision = snapshot.revision;
  let queue = Promise.resolve(),
    failure: unknown;
  const consumedFiles = new Set<string>();
  let consumedDocument: string | undefined;
  const commit = () => {
    // Snapshot now, so a later edit cannot change an earlier queued commit.
    const value = JSON.parse(JSON.stringify(saved));
    if (JSON.stringify(value).length > LIMIT) return Promise.reject(Error("Channel draft is too large"));
    const pending = queue.then(async () => {
      signal.throwIfAborted();
      if (failure) throw failure;
      const result = await document.compareAndSet(revision, value);
      if (!result.updated) throw Error("Channel draft changed in another window");
      revision = result.snapshot.revision;
    });
    queue = pending.catch((error) => {
      failure = error;
    });
    return pending;
  };
  const storage: ComposerDraftStorage = {
    read: () =>
      saved.content && {
        ...saved.content,
        attachments: saved.content.attachments.map((item) => ({
          ...item,
          uri: null,
          lifecycle: "failed" as const,
          error: attachmentError,
          metadata: undefined,
        })),
      },
    write: (_target, content) => {
      const incoming = content;
      if (consumedDocument && JSON.stringify(content.document) === consumedDocument)
        content = { ...content, document: createEmptyComposerDocument() };
      else consumedDocument = undefined;
      content = { ...content, attachments: content.attachments.filter((item) => !consumedFiles.has(item.id)) };
      for (const id of consumedFiles)
        if (!incoming.attachments.some((item) => item.id === id)) consumedFiles.delete(id);
      // File objects belong to the live view. Preserve a visible failed placeholder
      // across refresh, never a dead blob URL or a false claim of durable bytes.
      saved = {
        ...saved,
        content: {
          ...content,
          attachments: content.attachments.map((item) => ({ ...item, uri: null, metadata: undefined })),
        },
      };
      if (
        saved.attempt &&
        (saved.attempt.attachmentId
          ? !content.attachments.some((item) => item.id === saved.attempt!.attachmentId)
          : JSON.stringify(content.document) !== saved.attempt.document)
      )
        saved = { ...saved, attempt: null };
      return commit();
    },
  };
  return {
    storage,
    get attempt() {
      return saved.attempt ?? undefined;
    },
    get reply() {
      return saved.reply ?? undefined;
    },
    async acceptAttachment(id: string, documentKey?: string) {
      consumedFiles.add(id);
      if (saved.content) {
        const clear = documentKey !== undefined && JSON.stringify(saved.content.document) === documentKey;
        if (clear) consumedDocument = documentKey;
        saved = {
          ...saved,
          content: {
            ...saved.content,
            document: clear ? createEmptyComposerDocument() : saved.content.document,
            attachments: saved.content.attachments.filter((item) => item.id !== id),
          },
          attempt: saved.attempt?.attachmentId === id ? null : saved.attempt,
        };
        await commit();
      }
    },
    async setAttempt(attempt: ChannelDraftAttempt) {
      saved = { ...saved, attempt };
      await commit();
    },
    async setReply(reply: ChannelDraftReply | undefined) {
      saved = { ...saved, reply: reply ?? null };
      await commit();
    },
    async clear() {
      saved = { ...saved, content: null, attempt: null, reply: null };
      await commit();
    },
    async flush() {
      await queue;
      if (failure) throw failure;
    },
  };
}
export type ChannelDraftPersistence = Awaited<ReturnType<typeof openChannelDraftStorage>>;
