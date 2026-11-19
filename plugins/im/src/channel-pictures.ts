import {
  ResourceStore,
  type BlobResource,
  type BlobResourceService,
  type ResourceSnapshot,
} from "@opencraft/blob-resources";
import { BlobUrlManager } from "@opencraft/blob-resources/browser";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ChannelsClient } from "./channel-client";
import {
  createChannelResources,
  channelTargetKey,
  type ChannelResources,
  type ChannelResourceTarget,
} from "./channel-resources";

export interface ChannelPictureSource {
  readonly source: string;
}
export type ChannelPictureSnapshot = ResourceSnapshot<ChannelPictureSource>;
/** Group images and image attachments use separate representations of a message. */
export type ChannelPictureTarget = ChannelResourceTarget;
export interface ChannelPictures {
  revoke(group: string): void;
  restore(group: string): void;
  readonly resources: ChannelResources;
  retry(target: ChannelPictureTarget): Promise<void>;
  resource(target: ChannelPictureTarget): BlobResource;
  getSnapshot(resource: BlobResource): ChannelPictureSnapshot;
  subscribe(resource: BlobResource, listener: () => void): () => void;
}

/** Decoded pictures survive virtualized row recycling for this long after the last viewer. */
export const CHANNEL_PICTURE_RETENTION_MS = 10 * 60_000;
const urls = new BlobUrlManager();
const unavailable: ChannelPictureSnapshot = Object.freeze({
  status: "unavailable",
  value: null,
  isFetching: false,
  error: null,
});

/** Decode before publishing so a remounted row receives its final size in one frame. */
async function decoded(source: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (typeof Image === "undefined") return;
  const image = new Image();
  image.src = source;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      image.src = "";
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void image
      .decode()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Picture results are owned by the channel views, not by rows. Bytes go through
 * the application's blob scheduler when the host provides it; object URLs are
 * reference counted and revoked only after the presentation entry is evicted.
 */
export function createChannelPictures({
  client,
  scope,
  blobs,
  signal,
}: {
  client: ChannelsClient;
  scope: () => string;
  blobs?: BlobResourceService;
  signal: AbortSignal;
}): ChannelPictures {
  const revoked = new Set<string>(),
    known = new Map<string, BlobResource>();
  const resources = createChannelResources({ client, scope, blobs, signal });
  const parse = (resource: BlobResource): ChannelPictureTarget => {
    const [kind, group, sequence, path, mime] = JSON.parse(resource.path) as [
      ChannelPictureTarget["kind"],
      string,
      number,
      string | null,
      string | null,
    ];
    return { kind, group, sequence, path: path ?? undefined, mime: mime ?? undefined };
  };
  const prepare = async (resource: BlobResource, request: AbortSignal) => {
    const target = parse(resource);
    const value = await resources.read(target, request);
    const blob = !value.blob.type && target.mime ? new Blob([value.blob], { type: target.mime }) : value.blob;
    if (!["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(blob.type)) return null;
    if (!blob.size) return null;
    const url = urls.acquire(blob);
    try {
      await decoded(url.source, request);
    } catch (error) {
      url.release();
      throw error;
    }
    return { value: Object.freeze({ source: url.source }), sizeBytes: blob.size, dispose: url.release };
  };
  const options = { maxAgeMs: CHANNEL_PICTURE_RETENTION_MS };
  const store = blobs
    ? blobs.createResourceStore(prepare, options)
    : new ResourceStore(prepare, { ...options, memoryBytes: 32 * 1024 * 1024 });
  if (signal.aborted) store.close();
  else signal.addEventListener("abort", () => store.close(), { once: true });
  return {
    resources,
    revoke(group) {
      revoked.add(group);
      resources.revoke(group);
      for (const r of known.values()) if (parse(r).group === group) store.invalidate(r);
    },
    restore(group) {
      if (!revoked.delete(group)) return;
      resources.restore(group);
      for (const r of known.values()) if (parse(r).group === group) store.invalidate(r);
    },
    async retry(target) {
      await resources.retry(target);
      store.invalidate({ scope: scope(), path: channelTargetKey(target) });
    },
    resource: (target) => {
      const r = { scope: scope(), path: channelTargetKey(target) };
      known.set(r.path, r);
      return r;
    },
    getSnapshot: (resource) => (revoked.has(parse(resource).group) ? unavailable : store.getSnapshot(resource)),
    subscribe: (resource, listener) => store.subscribe(resource, listener),
  };
}

/**
 * Reads cached pictures synchronously on mount. A row subscribes (and so starts IO)
 * only once it is near the viewport, but always holds an already prepared result.
 */
export function useChannelPicture(
  pictures: ChannelPictures,
  target: ChannelPictureTarget | null,
  nearViewport: boolean,
): ChannelPictureSnapshot {
  const key = target && channelTargetKey(target);
  const resource = useMemo(() => (target ? pictures.resource(target) : null), [pictures, key]);
  const cachedReady = resource !== null && pictures.getSnapshot(resource).status === "ready";
  const active = resource !== null && (nearViewport || cachedReady);
  const subscribe = useCallback(
    (listener: () => void) => (active && resource ? pictures.subscribe(resource, listener) : () => {}),
    [pictures, resource, active],
  );
  const getSnapshot = useCallback(
    () => (resource ? pictures.getSnapshot(resource) : unavailable),
    [pictures, resource],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
