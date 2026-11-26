// Codex runs in its own AppServer owner, reached through the two fixed
// workspace endpoints already published by the Brain agent. The calling Host
// owns admission and RPC routing. This layer transports the private lane and
// observes native creation replies for the WorkspaceHost.
import {
  isJsonRpcRequest,
  isJsonRpcSuccess,
  parseJsonRpcMessage,
  SIDE_CHAT_INSTRUCTIONS,
  type JsonRpcId,
  type ThreadListParams,
} from "@opencraft/appserver-protocol";
import {
  parseWorkspaceEndpointUri,
  SandboxFault,
  type SandboxReceipt,
  type WorkspaceEndpointBinding,
  type WorkspaceRuntime,
} from "@opencraft/sandbox";
import { createdCodexThreadId, type CodexStartOptions } from "./codex-thread-start.js";
import {
  CODEX_WORKBENCH_THREAD_CONFIG,
  openNativeMutationLane,
  resumeNativeThread,
  type NativeMutationLane,
} from "./codex-turn.js";
import { isCodexThreadResult, type CodexHistoryRead, type CodexThreadRead } from "./codex-thread-read.js";
import { openWorkspaceBridgeLane, readWorkspaceBridgeHistory, type WorkspaceBridge } from "./workspace-bridge.js";
import {
  EndpointRpcError,
  endpointHttpRequest,
  endpointJsonRpcRequest,
  openEndpointWebSocket,
  type EndpointWebSocket,
} from "./workspace-link.js";

type Runtime = Pick<WorkspaceRuntime, "workspaceId" | "connect" | "describe" | "fenced">;

interface CodexObservation {
  readonly pid: number;
  readonly incarnation: string;
  readonly callbackIncarnation: string;
  readonly supportsThreadTitle: boolean;
}

const unavailable = () => new SandboxFault("SANDBOX_UNAVAILABLE", "Workspace Codex AppServer unavailable");
const positivePid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const incarnation = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

export const isWorkspaceCodexLane = (value: string) => /^[a-zA-Z0-9:_-]{1,256}$/u.test(value);
// Match the existing Codex callback relay's accepted frame size.
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export function attachWorkspaceCodex(
  runtime: Runtime,
  available: () => boolean,
  bridge?: { transport: WorkspaceBridge; serverId: string },
) {
  const control = parseWorkspaceEndpointUri(`workspace://${runtime.workspaceId}/endpoints/codex-control`);
  const native = parseWorkspaceEndpointUri(`workspace://${runtime.workspaceId}/endpoints/codex-native`);

  const requireAvailable = () => {
    if (!available()) throw unavailable();
  };

  const readHealth = async (
    nativeOnly: boolean,
    binding: Pick<WorkspaceEndpointBinding, "describe" | "connect">,
  ): Promise<CodexObservation> => {
    const descriptor = (await binding.describe()) as { token?: unknown } | null;
    if (typeof descriptor?.token !== "string" || !descriptor.token || descriptor.token.length > 1024)
      throw unavailable();
    const response = await endpointHttpRequest(
      (onData) => binding.connect(onData),
      nativeOnly ? "/native-health" : "/health",
      { headers: { authorization: `Bearer ${descriptor.token}` }, maxBytes: 16 * 1024 },
    );
    if (!response.ok) throw unavailable();
    const value = response.json() as Record<string, unknown> | null;
    // The Linux AppServer proves the native child's identity in its own PID
    // namespace. Never dial the in-container native path returned by health.
    if (
      value?.protocolVersion !== 1 ||
      !positivePid(value.pid) ||
      !positivePid(value.codexPid) ||
      !incarnation(value.executionIncarnation) ||
      value.callbackProtocolVersion !== 1 ||
      !incarnation(value.callbackIncarnation)
    )
      throw unavailable();
    return {
      pid: value.codexPid,
      incarnation: value.executionIncarnation,
      callbackIncarnation: value.callbackIncarnation,
      supportsThreadTitle: value.threadTitleToolVersion === 1,
    };
  };

  const read = (nativeOnly: boolean, receipt?: SandboxReceipt): Promise<CodexObservation> => {
    if (receipt) return runtime.fenced(control, (binding) => readHealth(nativeOnly, binding), receipt);
    requireAvailable();
    return readHealth(nativeOnly, {
      describe: () => runtime.describe(control),
      connect: (onData) => runtime.connect(control, onData),
    });
  };

  type RequestMethod =
    CodexHistoryRead["method"] | "thread/list" | "thread/start" | "thread/resume" | "project/list" | "project/create";
  const requestNative = (
    method: RequestMethod,
    params: Record<string, unknown>,
    beforeRequest?: () => Promise<void>,
    receipt?: SandboxReceipt,
  ) => {
    // The request owns only this socket. Reserving a replay lane for each
    // query leaves spent connections in the native callback relay's lane budget.
    return runtime.fenced(
      native,
      async (binding) => {
        await read(true, receipt);
        if (!receipt) requireAvailable();
        return endpointJsonRpcRequest(binding.connect, "/", method, params, {
          timeoutMs: 10_000,
          maxPayload: method === "thread/start" ? 48 * 1024 : 4 * 1024 * 1024,
          beforeRequest,
        });
      },
      receipt,
    );
  };

  const request = (
    method: RequestMethod,
    params: Record<string, unknown>,
    beforeRequest?: () => Promise<void>,
    receipt?: SandboxReceipt,
  ) => {
    if (!receipt) requireAvailable();
    if (bridge && !method.startsWith("project/")) {
      return (async () => {
        const lane = await openNativeMutationLane((_, onFrame) => openBridge(onFrame, false, receipt));
        try {
          return await lane.request(method, params, undefined, beforeRequest);
        } finally {
          await lane.close();
        }
      })();
    }
    return requestNative(method, params, beforeRequest, receipt);
  };

  const readOnly = (
    method: CodexHistoryRead["method"],
    params: Record<string, unknown> & { threadId: string },
    receipt?: SandboxReceipt,
    passiveNative = true,
  ) => {
    if (!receipt) requireAvailable();
    return bridge
      ? readWorkspaceBridgeHistory(
          bridge,
          method,
          params,
          (rpc, query, attached) => requestNative(rpc, query, undefined, attached),
          { receipt, passiveNative },
        )
      : requestNative(method, params, undefined, receipt);
  };

  let mutationLane: NativeMutationLane | undefined;
  let mutationBusy = false;
  let closed = false;
  const bridgeCreatedThreads = new Map<string, unknown>();
  const openBridge = (onFrame: (frame: string) => void, observe: boolean, expected?: SandboxReceipt) =>
    openWorkspaceBridgeLane(
      bridge!.transport,
      bridge!.serverId,
      (receive, receipt) =>
        codex.open(observe ? "workspace-mutation" : undefined, receive, receipt, expected !== undefined),
      onFrame,
      observe,
      expected,
    );
  const readThread = async (
    { threadId, includeTurns }: CodexThreadRead,
    invoke: (method: "thread/read", params: { threadId: string; includeTurns?: boolean }) => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      return await invoke("thread/read", { threadId, ...(includeTurns === undefined ? {} : { includeTurns }) });
    } catch (error) {
      if (
        !includeTurns ||
        !(error instanceof EndpointRpcError) ||
        error.code !== -32600 ||
        error.message !==
          `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`
      )
        throw error;
      // Native confirms no first input yet. Only a still-idle matching
      // Thread may use its metadata's empty history for this read.
      const metadata = await invoke("thread/read", { threadId, includeTurns: false });
      const thread = (metadata as { thread?: { id?: unknown; status?: { type?: unknown }; turns?: unknown } } | null)
        ?.thread;
      if (
        thread?.id !== threadId ||
        thread.status?.type !== "idle" ||
        !Array.isArray(thread.turns) ||
        thread.turns.length !== 0
      )
        throw error;
      return metadata;
    }
  };
  const codex = {
    async withMutationLane<T>(operation: (lane: NativeMutationLane) => Promise<T>): Promise<T> {
      if (closed || mutationBusy) throw unavailable();
      mutationBusy = true;
      try {
        if (bridge) {
          const lane = await openNativeMutationLane((_, onFrame) => openBridge(onFrame, true));
          try {
            return await operation({ ...lane, createdThreads: bridgeCreatedThreads });
          } finally {
            await lane.close();
          }
        }
        if (!mutationLane) {
          const opened = await openNativeMutationLane(codex.open);
          if (closed) {
            await opened.close();
            throw unavailable();
          }
          mutationLane = opened;
          void opened.closed.then(() => {
            if (mutationLane === opened) mutationLane = undefined;
          });
        }
        return await operation(mutationLane);
      } finally {
        mutationBusy = false;
      }
    },
    async readHistory(read: CodexHistoryRead, passiveNative = false, receipt?: SandboxReceipt): Promise<unknown> {
      const invoke = (method: CodexHistoryRead["method"], params: Record<string, unknown> & { threadId: string }) =>
        passiveNative || bridge
          ? readOnly(method, bridge && read.params.openArchivedHistory === true
            ? { ...params, openArchivedHistory: true } : params, receipt, passiveNative)
          : request(method, params, undefined, receipt);
      if (read.method === "thread/read") return readThread(read.params, invoke);
      const { threadId, cursor, openArchivedHistory: _demand, ...params } = read.params;
      try {
        return await invoke(read.method, { threadId, cursor, ...params });
      } catch (error) {
        if (
          cursor !== null ||
          !(error instanceof EndpointRpcError) ||
          error.code !== -32600 ||
          error.message !==
            `thread ${threadId} is not materialized yet; ${read.method} is unavailable before first user message`
        )
          throw error;
        const metadata = (await readThread({ threadId, includeTurns: false }, invoke)) as {
          thread?: { id?: unknown; ephemeral?: unknown; status?: { type?: unknown }; turns?: unknown };
        };
        const thread = metadata?.thread;
        if (
          thread?.id !== threadId ||
          thread.ephemeral !== false ||
          thread.status?.type !== "idle" ||
          !Array.isArray(thread.turns) ||
          thread.turns.length !== 0
        )
          throw error;
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
    },
    async close(): Promise<void> {
      closed = true;
      await mutationLane?.close();
    },
    discardUnmaterializedThreads(): void {
      bridgeCreatedThreads.clear();
      mutationLane?.createdThreads.clear();
    },
    async releaseIdleLane(): Promise<boolean> {
      if (mutationBusy || mutationLane?.createdThreads.size || bridgeCreatedThreads.size) return false;
      const lane = mutationLane;
      mutationLane = undefined;
      await lane?.close();
      return true;
    },
    async resumeThread(threadId: string, excludeTurns: boolean, receipt?: SandboxReceipt): Promise<unknown> {
      if (mutationLane?.createdThreads.has(threadId)) return resumeNativeThread(mutationLane, threadId, excludeTurns);
      const created = bridgeCreatedThreads.get(threadId);
      if (created && typeof created === "object")
        return {
          ...created,
          collaborationMode: null,
          initialTurnsPage: null,
          turnsBackwardsCursor: null,
          itemsBackwardsCursor: null,
        };
      return request(
        "thread/resume",
        { threadId, excludeTurns, config: CODEX_WORKBENCH_THREAD_CONFIG },
        undefined,
        receipt,
      );
    },
    async health(nativeOnly = false): Promise<CodexObservation> {
      requireAvailable();
      const observation = await runtime.fenced(control, () => read(nativeOnly));
      requireAvailable();
      return observation;
    },
    readThread(params: CodexThreadRead): Promise<unknown> {
      return readThread(params, bridge ? readOnly : request);
    },
    listThreads(params: ThreadListParams): Promise<unknown> {
      return request("thread/list", params);
    },
    projects(
      method: "project/list" | "project/create",
      params: Record<string, unknown>,
      authorize: () => Promise<void>,
      receipt?: SandboxReceipt,
    ): Promise<unknown> {
      return request(method, params, authorize, receipt);
    },
    readDirectoryAtPlacement(
      method: "thread/list" | "project/list",
      params: Record<string, unknown>,
      receipt: SandboxReceipt,
    ): Promise<unknown> {
      return request(method, params, undefined, receipt);
    },
    async startThread(
      beforeRequest: () => Promise<void>,
      retainSubscription: boolean,
      options: CodexStartOptions,
    ): Promise<unknown> {
      if (options.fork) {
        const { sideChat, ...fork } = options.fork;
        return codex.withMutationLane(async (lane) => {
          if (lane.createdThreads.has(fork.threadId)) throw unavailable();
          const source = await lane.request("thread/read", { threadId: fork.threadId, includeTurns: false });
          if (!isCodexThreadResult(source, fork.threadId)) throw unavailable();
          const { thread } = source as { thread: { status?: { type?: unknown }; cwd?: unknown } };
          const status = thread.status?.type;
          if (status !== "idle" && status !== "notLoaded") throw unavailable();
          if (sideChat?.cwd !== undefined && sideChat.cwd !== thread.cwd) throw unavailable();
          await beforeRequest();
          return lane.request("thread/fork", {
            ...fork,
            excludeTurns: true,
            ephemeral: false,
            deferGoalContinuation: true,
            config: CODEX_WORKBENCH_THREAD_CONFIG,
            ...(sideChat ? { developerInstructions: SIDE_CHAT_INSTRUCTIONS } : {}),
          });
        });
      }
      const params = {
        ephemeral: false,
        historyMode: options.historyMode ?? "legacy",
        config: CODEX_WORKBENCH_THREAD_CONFIG,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.projectId === undefined
          ? {}
          : { projectId: options.projectId, cwd: options.cwd, runtimeWorkspaceRoots: options.runtimeWorkspaceRoots }),
      };
      if (!retainSubscription) return request("thread/start", params, beforeRequest);
      return codex.withMutationLane(async (lane) => {
        await beforeRequest();
        const result = await lane.request("thread/start", params);
        const id = createdCodexThreadId(result);
        if (id) lane.createdThreads.set(id, result);
        return result;
      });
    },
    async open(
      lane: string | undefined,
      onMessage: (frame: string) => void,
      receipt?: SandboxReceipt,
      duringDrain = false,
    ): Promise<EndpointWebSocket & { readonly observation: CodexObservation }> {
      if (lane !== undefined && !isWorkspaceCodexLane(lane)) throw new Error("Invalid Codex callback lane");
      if (!duringDrain || !receipt) requireAvailable();
      let socket: EndpointWebSocket | undefined;
      let observation: CodexObservation | undefined;
      let published = false;
      let unexpected = false;
      try {
        await runtime.fenced(
          native,
          async (binding) => {
            observation = await read(true, receipt);
            if (!duringDrain) requireAvailable();
            socket = await openEndpointWebSocket(
              binding.connect,
              lane === undefined ? "/" : `/?opencraftLane=${encodeURIComponent(lane)}`,
              {
                maxPayload: MAX_MESSAGE_BYTES,
                onMessage(frame) {
                  if (published) onMessage(frame);
                  // Native sends no messages before initialize. A frame arriving
                  // before the placement check has completed is untrusted.
                  else unexpected = true;
                },
              },
            );
          },
          receipt,
        );
        if (!duringDrain) requireAvailable();
        if (unexpected) throw unavailable();
        published = true;
        return Object.assign(socket!, { observation: observation! });
      } catch (error) {
        await socket?.close().catch(() => {});
        throw error;
      }
    },
  };
  return codex;
}

export type WorkspaceCodex = ReturnType<typeof attachWorkspaceCodex>;

type OwnerSocket = WebSocket & { accept(): void };
type WorkerSocketRuntime = typeof globalThis & {
  WebSocketPair: new () => { 0: WebSocket; 1: OwnerSocket };
};

const MAX_PENDING_REQUESTS = 1024;
const MAX_REQUEST_ID_LENGTH = 1024;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** One private native lane. Only the response to a persistent creation is evidence of placement. */
class NativeThreadCreation {
  readonly #requests = new Map<JsonRpcId, boolean>();

  sent(frame: string): boolean {
    const message = parseJsonRpcMessage(frame);
    if (!isJsonRpcRequest(message)) return true;
    if (
      (typeof message.id === "string" && message.id.length > MAX_REQUEST_ID_LENGTH) ||
      this.#requests.has(message.id) ||
      this.#requests.size >= MAX_PENDING_REQUESTS
    )
      return false;
    const params = record(message.params);
    const persistent =
      (message.method === "thread/start" || message.method === "thread/fork") &&
      params?.ephemeral !== true &&
      params?.__opencraftDeferPublication !== true;
    this.#requests.set(message.id, persistent);
    return true;
  }

  received(frame: string): string | undefined {
    if (!this.#requests.size) return undefined;
    const message = parseJsonRpcMessage(frame);
    if ("method" in message || message.id === null) return undefined;
    const persistent = this.#requests.get(message.id);
    this.#requests.delete(message.id);
    if (!persistent || !isJsonRpcSuccess(message)) return undefined;
    const thread = record(record(message.result)?.thread);
    return thread?.ephemeral === false && typeof thread.id === "string" ? thread.id : undefined;
  }
}

/** Private owner-to-owner upgrade. No frame is retried after a disconnect. */
export async function bridgeWorkspaceCodex(
  codex: WorkspaceCodex,
  lane: string,
  commitCreated: (threadId: string) => Promise<void>,
): Promise<Response> {
  const { WebSocketPair } = globalThis as WorkerSocketRuntime;
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  let native: EndpointWebSocket | undefined;
  let ended = false;
  const close = (code: number) => {
    if (ended) return;
    ended = true;
    try {
      server.close(code);
    } catch {
      // A peer may already have finished the close handshake.
    }
    void native?.close().catch(() => {});
  };

  const creation = new NativeThreadCreation();
  const encoder = new TextEncoder();
  let replyBytes = 0;
  let replies = Promise.resolve();
  try {
    native = await codex.open(lane, (frame) => {
      if (ended) return;
      try {
        const threadId = creation.received(frame);
        // Capture the actual success even if the receiving lane closes while the owner commits.
        const committed =
          threadId === undefined
            ? undefined
            : commitCreated(threadId).then(
                () => true,
                () => false,
              );
        const bytes = encoder.encode(frame).byteLength;
        if (replyBytes + bytes > MAX_MESSAGE_BYTES || server.bufferedAmount >= MAX_MESSAGE_BYTES) return close(1013);
        replyBytes += bytes;
        replies = replies
          .then(async () => {
            if (committed && !(await committed)) return close(1011);
            if (!ended) server.send(frame);
          })
          .catch(() => close(1011))
          .finally(() => {
            replyBytes -= bytes;
          });
      } catch {
        close(1011);
      }
    });
  } catch (error) {
    close(1011);
    throw error;
  }
  if (ended) void native.close().catch(() => {});
  let queuedBytes = 0;
  let pending = Promise.resolve();
  server.addEventListener("message", ({ data }) => {
    if (ended) return;
    if (typeof data !== "string") return close(1003);
    if (!data.length) return close(1007);
    if (data.length > MAX_MESSAGE_BYTES) return close(1009);
    const bytes = encoder.encode(data).byteLength;
    if (bytes > MAX_MESSAGE_BYTES) return close(1009);
    if (queuedBytes + bytes > MAX_MESSAGE_BYTES) return close(1013);
    queuedBytes += bytes;
    pending = pending
      .then(async () => {
        if (ended) return;
        if (!creation.sent(data)) return close(1008);
        await native!.send(data);
      })
      .catch(() => close(1011))
      .finally(() => {
        queuedBytes -= bytes;
      });
  });
  server.addEventListener("close", () => close(1000));
  server.addEventListener("error", () => close(1011));
  void native.closed.then(() => close(1012));
  const upgrade: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };
  return new Response(null, upgrade);
}
