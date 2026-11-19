import {
  ResourceStore,
  type BlobResource,
  type BlobResourceService,
  type ResourceSnapshot,
} from "@opencraft/blob-resources";
import { useCallback, useMemo, useSyncExternalStore, useEffect, useState } from "react";
import type { ChannelsClient } from "./channel-client";

export interface ChannelResourceTarget {
  readonly group: string;
  readonly sequence: number;
  readonly kind: "image" | "attachment" | "record";
  readonly path?: string;
  readonly mime?: string;
}
export interface ChannelResourceValue {
  readonly blob: Blob;
  readonly name?: string;
}
export type ChannelResourceSnapshot = ResourceSnapshot<ChannelResourceValue>;
export interface ChannelResources {
  revoke(group: string): void;
  restore(group: string): void;
  resource(target: ChannelResourceTarget): BlobResource;
  getSnapshot(resource: BlobResource): ChannelResourceSnapshot;
  subscribe(resource: BlobResource, listener: () => void): () => void;
  read(target: ChannelResourceTarget, signal: AbortSignal): Promise<ChannelResourceValue>;
  retry(target: ChannelResourceTarget): Promise<void>;
}
export const CHANNEL_RESOURCE_RETENTION_MS = 10 * 60_000;
export const channelTargetKey = (target: ChannelResourceTarget) =>
  JSON.stringify([target.kind, target.group, target.sequence, target.path ?? null, target.mime ?? null]);

/** One authenticated view scope shares bytes between thumbnails, preview and download.
 * ResourceStore owns coalescing, bounded retention, cancellation and late results. */
export function createChannelResources({
  client,
  scope,
  blobs,
  signal,
}: {
  client: ChannelsClient;
  scope(): string;
  blobs?: BlobResourceService;
  signal: AbortSignal;
}): ChannelResources {
  const revoked = new Set<string>(),
    known = new Map<string, BlobResource>();
  const target = (resource: BlobResource): ChannelResourceTarget => {
    const [kind, group, sequence, path, mime] = JSON.parse(resource.path);
    return { kind, group, sequence, path: path ?? undefined, mime: mime ?? undefined };
  };
  const load = async (resource: BlobResource, request: AbortSignal) => {
    const t = target(resource);
    if (revoked.has(t.group)) throw Error("channel_denied");
    if (t.kind === "record") {
      if (!t.path) throw Error("record_resource_missing");
      return client.recordResource(t.group, t.sequence, t.path, request);
    }
    return {
      blob: await (t.kind === "image"
        ? client.image(t.group, t.sequence, request)
        : client.attachment(t.group, t.sequence, request)),
    };
  };
  const prepare = async (resource: BlobResource, request: AbortSignal) => {
    let value: ChannelResourceValue;
    if (blobs) {
      let name: string | undefined;
      const lease = blobs.acquire(
        resource,
        async (_, owned) => {
          const value = await load(resource, owned);
          name = "name" in value ? value.name : undefined;
          return value.blob;
        },
        { signal: request, priority: 1, maxAgeMs: CHANNEL_RESOURCE_RETENTION_MS },
      );
      try {
        value = { blob: await lease.promise, name };
      } finally {
        lease.release();
      }
    } else value = await load(resource, request);
    request.throwIfAborted();
    return { value: Object.freeze(value), sizeBytes: value.blob.size };
  };
  const options = { maxAgeMs: CHANNEL_RESOURCE_RETENTION_MS, memoryBytes: 32 * 1024 * 1024 };
  const store = blobs ? blobs.createResourceStore(prepare, options) : new ResourceStore(prepare, options);
  if (signal.aborted) store.close();
  else signal.addEventListener("abort", () => store.close(), { once: true });
  const resource = (t: ChannelResourceTarget) => {
    const r = { scope: scope(), path: channelTargetKey({ ...t, mime: undefined }) };
    known.set(r.path, r);
    return r;
  };
  return {
    revoke(group) {
      revoked.add(group);
      for (const r of known.values())
        if (target(r).group === group) {
          store.invalidate(r);
          void blobs?.invalidate(r).catch(() => {});
        }
    },
    restore(group) {
      if (!revoked.delete(group)) return;
      for (const r of known.values()) if (target(r).group === group) store.invalidate(r);
    },
    resource,
    getSnapshot: (r) => (revoked.has(target(r).group) ? unavailable : store.getSnapshot(r)),
    subscribe: (r, fn) => store.subscribe(r, fn),
    read(t, request) {
      request.throwIfAborted();
      signal.throwIfAborted();
      const r = resource(t);
      return new Promise((resolve, reject) => {
        let release: (() => void) | undefined;
        let settled = false;
        const finish = (error?: unknown, value?: ChannelResourceValue) => {
          if (settled) return;
          settled = true;
          request.removeEventListener("abort", abort);
          signal.removeEventListener("abort", abort);
          release?.();
          error ? reject(error) : resolve(value!);
        };
        const abort = () => finish(request.reason ?? signal.reason ?? Error("aborted"));
        const check = () => {
          if (request.aborted || signal.aborted) return abort();
          const s = store.getSnapshot(r);
          if (s.status === "ready" && s.value) finish(undefined, s.value);
          else if (s.status === "unavailable") finish(s.error ?? Error("resource_unavailable"));
        };
        request.addEventListener("abort", abort, { once: true });
        signal.addEventListener("abort", abort, { once: true });
        release = store.subscribe(r, check);
        if (settled) release();
        else check();
      });
    },
    async retry(t) {
      const r = resource(t);
      signal.throwIfAborted();
      if (blobs) await blobs.invalidate(r);
      signal.throwIfAborted();
      store.invalidate(r);
    },
  };
}

const unavailable: ChannelResourceSnapshot = Object.freeze({
  status: "unavailable",
  value: null,
  isFetching: false,
  error: null,
});
export function useChannelResource(
  resources: ChannelResources,
  target: ChannelResourceTarget | null,
  active: boolean,
): ChannelResourceSnapshot {
  const key = target && channelTargetKey(target);
  const resource = useMemo(() => (target ? resources.resource(target) : null), [resources, key]);
  const subscribe = useCallback(
    (fn: () => void) => (active && resource ? resources.subscribe(resource, fn) : () => {}),
    [resources, resource, active],
  );
  const get = useCallback(() => (resource ? resources.getSnapshot(resource) : unavailable), [resources, resource]);
  return useSyncExternalStore(subscribe, get, get);
}

/** Both timeline and forwarded rows use the same lazy activation boundary. */
export function useChannelResourceVisible(host: import("react").RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible || !host.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [host, visible]);
  return visible;
}
