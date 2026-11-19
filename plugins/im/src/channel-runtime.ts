import type { ChannelMember, ChannelSummary, PersonalAssistantStatus } from "@opencraft/appserver-protocol";
import { combineAbortSignals } from "@opencraft/appserver-client/transport";
import { ChannelsClient, type ChannelRpc } from "./channel-client";
import { ImHttpError } from "./client";
import { inboxGroups } from "./people-directory";

export type ChannelReadState<T> = { value?: T; failed: boolean; authoritative: boolean; error?: unknown };
export interface ChannelRead<T> {
  get(): ChannelReadState<T>;
  subscribe(fn: () => void): () => void;
  refresh(signal?: AbortSignal): Promise<void>;
  set(value: T): void;
  hold(): () => void;
  invalidate(): void;
  fail(error: unknown): void;
  clear(): void;
  readonly observed: boolean;
}
const denied = (error: unknown) =>
  (error instanceof ImHttpError && [401, 403].includes(error.status)) ||
  (error instanceof Error && error.message === "channel_denied");
/** A replica owns cancellation and publication, rather than a mounted View. */
export function createChannelRead<T>(scope: AbortSignal, read: (signal: AbortSignal) => Promise<T>): ChannelRead<T> {
  let state: ChannelReadState<T> = { failed: false, authoritative: false },
    retired = false,
    held = 0,
    owner: AbortController | undefined,
    flight: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: typeof state) => {
    state = next;
    for (const fn of [...listeners]) fn();
  };
  const cancel = () => {
    owner?.abort();
    owner = undefined;
    flight = undefined;
  };
  const resource: ChannelRead<T> = {
    get: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    get observed() {
      return listeners.size > 0;
    },
    refresh(signal) {
      if (retired || scope.aborted || held) return Promise.resolve();
      if (flight) return flight;
      const current = new AbortController();
      owner = current;
      const request = combineAbortSignals([
        scope,
        current.signal,
        ...(signal ? [signal] : []),
        AbortSignal.timeout(10000),
      ]);
      const pending = read(request.signal)
        .then(
          (value) => {
            if (owner === current && !request.signal.aborted && !retired)
              publish({ value, failed: false, authoritative: true });
          },
          (error) => {
            if (owner !== current || scope.aborted || current.signal.aborted || signal?.aborted || retired) return;
            publish(
              denied(error)
                ? { failed: true, authoritative: false, error }
                : { ...state, failed: true, authoritative: false, error },
            );
          },
        )
        .finally(() => {
          request.dispose();
          if (owner === current) {
            owner = undefined;
            flight = undefined;
          }
        });
      return (flight = pending);
    },
    set(value) {
      if (retired || scope.aborted) return;
      cancel();
      publish({ value, failed: false, authoritative: true });
    },
    hold() {
      cancel();
      held++;
      let active = true;
      return () => {
        if (active) {
          active = false;
          held--;
        }
      };
    },
    invalidate() {
      if (retired) return;
      cancel();
      publish({ ...state, failed: false, error: undefined, authoritative: false });
    },
    fail(error) {
      if (retired || scope.aborted) return;
      cancel();
      publish(
        denied(error) ? { failed: true, authoritative: false } : { ...state, failed: true, authoritative: false },
      );
    },
    clear() {
      retired = true;
      cancel();
      publish({ failed: true, authoritative: false });
    },
  };
  scope.addEventListener("abort", () => resource.clear(), { once: true });
  if (scope.aborted) resource.clear();
  return resource;
}
export type ChannelDirectory = {
  groups: ChannelSummary[];
  all: ChannelSummary[];
  members: Record<string, ChannelMember[]>;
};
const runtimes = new WeakMap<ChannelRpc, ChannelRuntime>();
/** One authenticated extension owns one directory and one assistant observation. */
export function getChannelRuntime(fetcher: typeof fetch, transport: ChannelRpc, activation: AbortSignal) {
  const resident = runtimes.get(transport);
  if (resident) return resident;
  const scope = new AbortController(),
    identity = transport.draftScope,
    scopeListeners = new Set<() => void>();
  const assertScope = () => {
    if (transport.draftScope !== identity) scope.abort(Error("Channel identity changed"));
    scope.signal.throwIfAborted();
  };
  const rpc: ChannelRpc = {
    get draftScope() {
      return identity;
    },
    get supportsGroupLifecycle() {
      return transport.supportsGroupLifecycle;
    },
    get supportsRead() {
      return transport.supportsRead;
    },
    get supportsAttachments() {
      return transport.supportsAttachments;
    },
    get supportsAttachmentChunks() {
      return transport.supportsAttachmentChunks;
    },
    async connect() {
      assertScope();
      await transport.connect();
      assertScope();
    },
    async request(method, params, signal, options) {
      assertScope();
      const request = combineAbortSignals([scope.signal, ...(signal ? [signal] : [])]);
      try {
        const value = await transport.request(method, params, request.signal, options);
        assertScope();
        request.signal.throwIfAborted();
        return value;
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "actor_authentication_required" || (error as { status?: number }).status === 401)
        )
          scope.abort(error);
        throw error;
      } finally {
        request.dispose();
      }
    },
    onChanged: (fn) => transport.onChanged(fn),
    onDisconnect: (fn) => transport.onDisconnect(fn),
    onRecoveryHint: (fn) => transport.onRecoveryHint?.(fn) ?? (() => {}),
    close: () => transport.close(),
  };
  const client = new ChannelsClient(fetcher, rpc);
  const directory = createChannelRead(scope.signal, async (signal) => {
    const { groups: all } = await client.list(signal),
      groups = inboxGroups(all);
    const members = await Promise.all(
      groups.slice(0, 12).map(async (group) => {
        try {
          return [group.id, (await client.members(group.id, signal)).members.slice(0, 9)] as const;
        } catch (error) {
          signal.throwIfAborted();
          return [group.id, [] as ChannelMember[]] as const;
        }
      }),
    );
    signal.throwIfAborted();
    return { all, groups, members: Object.fromEntries(members) };
  });
  const assistant = createChannelRead<PersonalAssistantStatus>(scope.signal, (signal) =>
    client.assistantStatus(signal),
  );
  const runtime = {
    rpc,
    client,
    directory,
    assistant,
    identity,
    signal: scope.signal,
    subscribeScope: (fn: () => void) => {
      scopeListeners.add(fn);
      return () => {
        scopeListeners.delete(fn);
      };
    },
    getScope: () => !scope.signal.aborted,
  };
  runtimes.set(transport, runtime);
  const detachIdentity = transport.onDisconnect(() => {
    if (transport.draftScope !== identity) scope.abort(Error("Channel identity changed"));
  });
  const abort = () => scope.abort(activation.reason);
  activation.addEventListener("abort", abort, { once: true });
  const poll = setInterval(() => {
    if (assistant.observed) void assistant.refresh();
  }, 2500);
  scope.signal.addEventListener(
    "abort",
    () => {
      clearInterval(poll);
      void transport.close().catch(() => {});
      detachIdentity();
      activation.removeEventListener("abort", abort);
      for (const fn of [...scopeListeners]) fn();
    },
    { once: true },
  );
  client.watch(
    undefined,
    async (signal) => {
      await directory.refresh(signal);
      if (signal.aborted) return;
      if (directory.get().failed) throw directory.get().error;
      void assistant.refresh(signal);
    },
    (error) => {
      if (denied(error)) scope.abort(error);
      else {
        directory.fail(error);
        assistant.fail(error);
      }
    },
    scope.signal,
    {
      onInvalidate: () => {
        void assistant.refresh();
      },
      onConnectionLost: () => {
        directory.invalidate();
        assistant.invalidate();
      },
    },
  );
  if (activation.aborted) abort();
  return runtime;
}
export type ChannelRuntime = {
  readonly rpc: ChannelRpc;
  readonly client: ChannelsClient;
  readonly directory: ChannelRead<ChannelDirectory>;
  readonly assistant: ChannelRead<PersonalAssistantStatus>;
  readonly identity: string | undefined;
  readonly signal: AbortSignal;
  subscribeScope(fn: () => void): () => void;
  getScope(): boolean;
};
