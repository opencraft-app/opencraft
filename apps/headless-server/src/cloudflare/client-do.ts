import { AppHostServer } from "@opencraft/app-host-server";
import { APP_HOST_IDLE_PROBE_ID, APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol";
import {
  HOST_TERMINAL_METHODS,
  OPENCRAFT_MODEL_CATALOG_REVALIDATION_EXTENSION,
  OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
  OPENCRAFT_METHOD_ACCESS_EXTENSION,
  OPENCRAFT_RESUME_HISTORY_EXTENSION,
  OPENCRAFT_TERMINAL_EXTENSION,
  OPENCRAFT_THREAD_START_DURABILITY_EXTENSION,
  OPENCRAFT_THREAD_LIFECYCLE_EXTENSION,
  OPENCRAFT_THREAD_FOLLOW_UP_EXTENSION,
  WORKSPACE_HISTORY_ASLEEP,
  SHARED_INTERACTIONS_EXTENSION,
  SHARED_INTERACTIONS_READ,
  SHARED_INTERACTIONS_RESPOND,
  WORKSPACE_PLACEMENT_EXTENSION,
  isHostTerminalMethod,
  isJsonRpcRequest,
  parseJsonRpcMessage,
  parseSharedInteractionSnapshot,
  type JsonRpcId,
  type OpenCraftResumeHistoryCapability,
} from "@opencraft/appserver-protocol";
import { HISTORY_PREVIEW_CURSOR_EXPIRED } from "@opencraft/appserver-protocol/history-preview";
import {
  TransportStatusObservers,
  type DuplexTransport,
  type TransportStatus,
  type TransportSubmissionContext,
} from "@opencraft/appserver-client/transport";
import { acceptAppHostClientSession } from "@opencraft/client-session/app-host";
import {
  WORKSPACE_CODEX_CONTROL_OPERATION,
  WORKSPACE_CODEX_READ_OPERATION,
  WORKSPACE_CODEX_TURN_OPERATION,
  WORKSPACE_FILES_OPERATION,
  WORKSPACE_PROJECTS_OPERATION,
  WORKSPACE_HOST_HEADER,
  WORKSPACE_HOST_OBJECT_PREFIX,
  workspaceHostObjectName,
} from "../workspace-host-routes.js";
import type { InstallationCoreEnv, WorkspaceHostNamespace } from "./bindings.js";
import {
  CLIENT_SOCKET_PATH,
  clientAttachmentRefusal,
  currentClientAttachment,
  parseClientAttachment,
  readClientAttachment,
  type ClientAttachment,
} from "./client-attachment.js";
import {
  CODEX_HISTORY_RESPONSE_TOO_LARGE,
  CODEX_THREAD_ARCHIVED,
  isCodexHistoryResult,
  lookupCodexThread,
  parseCodexHistoryRead,
  readsOrdinaryCodexHistoryBody,
  type CodexHistoryRead,
} from "./codex-thread-read.js";
import { CODEX_THREAD_START_PATH, createdCodexThreadId, parseCodexStartRequest } from "./codex-thread-start.js";
import { CODEX_MODEL_LIST_PATH, isCodexModelList, parseCodexModelList } from "./codex-model-list.js";
import { CODEX_THREAD_LIST_PATH, parseCodexThreadList, parseCodexThreadPage } from "./codex-thread-list.js";
import {
  CODEX_TURN_STREAM_TYPE,
  codexTurnAuthority,
  isCodexThreadMutation,
  matchesCodexResume,
  parseCodexSteerReceipt,
  parseCodexThreadMutationReceipt,
  parseCodexTurn,
  parseCodexTurnOperation,
  parseCodexUnsubscribe,
  parseTurnStreamFrame,
  scopedCodexTurnEvent,
  type CodexResume,
} from "./codex-turn.js";
import { INSTALLATION_CORE_OBJECT } from "./installation-core.js";
import { sameThreadPlacement, type ThreadPlacementReceipt } from "./thread-placement.js";
import { CODEX_WORKBENCH_HOST_ID } from "./codex-workspace.js";
import { connectClientTerminal, readClientTerminalInventory } from "./client-terminal.js";
import {
  isWorkspaceFileMethod,
  isWorkspaceFileResult,
  parseWorkspaceFileCall,
  WORKSPACE_FILE_METHODS,
} from "./workspace-files.js";
import { PROJECTLESS_WORKSPACE } from "./workspace-paths.js";
import {
  isWorkspaceProjectMethod,
  isWorkspaceProjectResult,
  parseWorkspaceProjectCall,
  WORKSPACE_PROJECT_METHODS,
} from "./workspace-projects.js";
import { terminalWorkspace } from "./terminal-authority.js";

type ClientEnv = InstallationCoreEnv & { readonly WORKSPACE_HOST: WorkspaceHostNamespace };
interface ClientState {
  waitUntil(promise: Promise<unknown>): void;
  acceptWebSocket(socket: OwnerSocket): void;
  getWebSockets(): OwnerSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
}
type ClaimTurnStream = (threadId: string, turnId: string, detach: () => void) => (() => void) | undefined;
type OwnerSocket = WebSocket & {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};
type SocketRuntime = typeof globalThis & {
  WebSocketPair: new () => { 0: WebSocket; 1: OwnerSocket };
  WebSocketRequestResponsePair: new (request: string, response: string) => unknown;
};
type SocketCheckpoint = {
  version: 1;
  identity: ClientAttachment;
  rendererId: string | null;
  generation: number;
  leases: Array<{ id: string; initialized: boolean }>;
};
type SocketSession = {
  message(data: string | ArrayBuffer): Promise<void> | void;
  close(code: number, reason: string): void;
};

const MAX_PENDING_FRAMES = 16;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_BUFFERED_OUTPUT = 8 * 1024 * 1024;
const MAX_READS = 4;
const MAX_CHECKPOINT_BYTES = 14 * 1024;
const socketEncoder = new TextEncoder();

function socketCheckpoint(socket: OwnerSocket): SocketCheckpoint | null {
  const value = socket.deserializeAttachment() as Partial<SocketCheckpoint> | null;
  const identity = parseClientAttachment(value?.identity);
  if (
    !identity ||
    value?.version !== 1 ||
    (value.rendererId !== null && typeof value.rendererId !== "string") ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !Array.isArray(value.leases) ||
    value.leases.some((l) => typeof l?.id !== "string" || typeof l.initialized !== "boolean") ||
    (value.leases.length > 0 && (!value.rendererId || value.generation === 0))
  )
    return null;
  return { version: 1, identity, rendererId: value.rendererId, generation: value.generation, leases: value.leases };
}
class CodexHistoryReadError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: object,
  ) {
    super(message);
  }
}

async function* readCodexStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, limit: number) {
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  try {
    while (!signal.aborted) {
      const entry = await reader.read();
      if (entry.done) {
        if (pending + decoder.decode()) throw new Error("Incomplete Codex frame");
        return;
      }
      pending += decoder.decode(entry.value, { stream: true });
      let line: number;
      while (!signal.aborted && (line = pending.indexOf("\n")) !== -1) {
        if (line > limit) throw new Error("Oversized Codex frame");
        const frame: unknown = JSON.parse(pending.slice(0, line));
        pending = pending.slice(line + 1);
        yield frame;
      }
      if (pending.length > limit) throw new Error("Oversized Codex frame");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
  }
}

function codexHostLease(ready: boolean): DuplexTransport {
  const observers = new TransportStatusObservers();
  const execution = ready ? "ready" : "unavailable";
  let status: TransportStatus = { state: "idle", execution };
  const publish = (state: TransportStatus["state"]) => {
    const next: TransportStatus = { state, execution };
    status = next;
    observers.emit(next, () => status === next);
  };
  return {
    get status() {
      return status;
    },
    async connect(signal) {
      signal?.throwIfAborted();
      publish("open");
    },
    async close() {
      publish("closed");
    },
    async send() {
      throw new Error("No direct native forwarding is available");
    },
    subscribeStatus(listener) {
      return observers.subscribe(listener, status);
    },
    subscribeMessage() {
      return () => {};
    },
  };
}

const rpcError = (id: JsonRpcId, code: number, message: string, data?: object) =>
  JSON.stringify({ id, error: { code, message, data } });

/** One admitted browser instance, speaking the same App Host wire as Node. */
export class ClientDO {
  readonly #sessions = new WeakMap<OwnerSocket, SocketSession>();
  #upgrade = 0;
  #accepted = 0;
  #reads = 0;

  constructor(
    private readonly ctx: ClientState,
    private readonly env: ClientEnv,
  ) {
    const { WebSocketRequestResponsePair } = globalThis as SocketRuntime;
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "connection/probe", requestId: APP_HOST_IDLE_PROBE_ID }),
        JSON.stringify({ type: "response", requestId: APP_HOST_IDLE_PROBE_ID, ok: true, result: null }),
      ),
    );
  }

  #installation() {
    const namespace = this.env.INSTALLATION_CORE;
    return namespace.get(namespace.idFromName(INSTALLATION_CORE_OBJECT));
  }

  async fetch(request: Request): Promise<Response> {
    if (
      new URL(request.url).pathname !== CLIENT_SOCKET_PATH ||
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    )
      return clientAttachmentRefusal(404, "missing");
    const attachment = readClientAttachment(request);
    if (request.headers.has("cookie") || request.headers.has("authorization") || !attachment)
      return clientAttachmentRefusal(403, "client_attachment_required");
    const upgrade = ++this.#upgrade;
    if (!(await currentClientAttachment(this.#installation(), attachment)))
      return clientAttachmentRefusal(403, "client_admission_revoked");
    if (upgrade < this.#accepted) return clientAttachmentRefusal(409, "client_socket_superseded");
    this.#accepted = upgrade;
    for (const socket of this.ctx.getWebSockets()) this.#closeSocket(socket, 1012, "Client connection superseded");
    const { WebSocketPair } = globalThis as SocketRuntime;
    const { 0: client, 1: socket } = new WebSocketPair();
    this.ctx.acceptWebSocket(socket);
    socket.serializeAttachment({
      version: 1,
      identity: attachment,
      rendererId: null,
      generation: 0,
      leases: [],
    } satisfies SocketCheckpoint);
    const response: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };
    return new Response(null, response);
  }

  #closeSocket(socket: OwnerSocket, code: number, reason: string) {
    const session = this.#sessions.get(socket);
    if (session) return session.close(code, reason);
    try {
      socket.serializeAttachment(null);
    } catch {
      /* The closing socket may have released its attachment. */
    }
    try {
      if (code === 1005 || code === 1006 || code === 1015) socket.close();
      else socket.close(code, reason);
    } catch {
      /* The peer already closed the connection. */
    }
  }

  webSocketMessage(socket: OwnerSocket, data: string | ArrayBuffer) {
    let session = this.#sessions.get(socket);
    if (!session) {
      const checkpoint = socketCheckpoint(socket);
      if (!checkpoint) return this.#closeSocket(socket, 1012, "Client connection unavailable");
      session = this.#openSession(socket, checkpoint);
      this.#sessions.set(socket, session);
    }
    return session.message(data);
  }

  webSocketClose(socket: OwnerSocket, code: number, reason: string) {
    this.#closeSocket(socket, code, reason);
  }

  webSocketError(socket: OwnerSocket) {
    this.#closeSocket(socket, 1011, "Client socket unavailable");
  }

  #openSession(socket: OwnerSocket, checkpoint: SocketCheckpoint): SocketSession {
    const attachment = checkpoint.identity;
    let ended = false;
    let restoring = false;
    let restore: Promise<void> | undefined;
    let restoreResponse: ((value: { ok?: unknown; result?: unknown }) => void) | undefined;
    const leases = new Map(checkpoint.leases.map((lease) => [lease.id, lease]));
    const commit = () => {
      const value = { ...checkpoint, leases: [...leases.values()] };
      if (socketEncoder.encode(JSON.stringify(value)).byteLength > MAX_CHECKPOINT_BYTES)
        throw new Error("Client socket checkpoint is too large");
      socket.serializeAttachment(value);
    };
    const canTurn = this.env.OPENCRAFT_WORKSPACE_CODEX_TURNS === "true" && !!this.env.OPENCRAFT_WORKSPACE_CODEX_DEFAULT;
    const appHost = new AppHostServer({
      initialHostGeneration: checkpoint.generation - (leases.size ? 1 : 0),
      createTransport(hostId) {
        if (hostId !== CODEX_WORKBENCH_HOST_ID) throw new Error("Host unavailable");
        return codexHostLease(canTurn);
      },
      createRpcAccessSession: (_hostId, _context, emit, leaseId) =>
        this.#access(
          attachment,
          emit,
          canTurn,
          () => close(1012, "Native Turn stream unavailable"),
          () => close(1012, "Hands terminal stream unavailable"),
          leases.get(leaseId)?.initialized === true,
          () => {
            const lease = leases.get(leaseId);
            if (lease && !lease.initialized) {
              lease.initialized = true;
              commit();
            }
          },
        ),
    });
    const finish = (code: number) => {
      if (ended) return;
      ended = true;
      this.#sessions.delete(socket);
      restoreResponse?.({ ok: false });
      handler.close(code);
      this.ctx.waitUntil(appHost.close().catch(() => undefined));
    };
    const close = (code: number, reason: string) => {
      if (ended) return;
      // Some runtime-generated codes (for example 1006) cannot be sent.
      try {
        socket.serializeAttachment(null);
      } catch {
        /* No checkpoint remains on a closed socket. */
      }
      try {
        if (code === 1005 || code === 1006 || code === 1015) socket.close();
        else socket.close(code, reason);
      } catch {
        // The peer might already have closed the physical connection.
      } finally {
        finish(code);
      }
    };
    const retire = () => close(1012, "Client connection superseded");
    const outstanding = new Set<string>();
    const pendingClaims = new Map<
      string,
      { type: "host/connect" | "host/disconnect"; leaseId: string; generation?: number }
    >();
    const handler = acceptAppHostClientSession<TransportSubmissionContext>(
      {
        get readyState() {
          return socket.readyState;
        },
        get bufferedAmount() {
          return socket.bufferedAmount ?? 0;
        },
        send(frame, done) {
          if (ended) return;
          if (restoring) {
            done?.();
            return;
          }
          if (socket.bufferedAmount >= MAX_BUFFERED_OUTPUT) {
            close(1013, "Client output congested");
            return;
          }
          try {
            socket.send(typeof frame === "string" ? frame : frame.slice());
            done?.();
          } catch {
            done?.(new Error("Client socket send failed"));
            close(1011, "Client socket unavailable");
          }
        },
        close,
        terminate: retire,
      },
      {
        appHostServer: appHost,
        submissionContext: { sender: null },
        idleProbe: true,
        authorize(message) {
          if (restoring) {
            if (message.type === "response" && message.requestId === "restore-lease")
              restoreResponse?.({ ok: message.ok, result: message.result });
            return !ended;
          }
          if (message.type === "hello" && typeof message.rendererId === "string")
            checkpoint.rendererId = message.rendererId;
          if (message.type === "ready") commit();
          if (message.type === "response" && typeof message.requestId === "string") {
            outstanding.delete(message.requestId);
            const claim = pendingClaims.get(message.requestId);
            pendingClaims.delete(message.requestId);
            if (message.ok === true && claim) {
              if (claim.type === "host/connect") {
                const result = message.result as { generation: number };
                if (checkpoint.generation !== result.generation) leases.clear();
                checkpoint.generation = result.generation;
                if (!leases.has(claim.leaseId)) leases.set(claim.leaseId, { id: claim.leaseId, initialized: false });
              } else if (claim.generation === checkpoint.generation) leases.delete(claim.leaseId);
              commit();
            }
          } else if (
            typeof message.requestId === "string" &&
            (message.type === "host/send" ||
              message.type === "host/connect" ||
              message.type === "host/disconnect" ||
              message.type === "connection/probe")
          ) {
            if (outstanding.size >= MAX_PENDING_FRAMES || outstanding.has(message.requestId)) {
              close(1013, "Client request capacity exhausted");
              return false;
            }
            outstanding.add(message.requestId);
            if (
              (message.type === "host/connect" || message.type === "host/disconnect") &&
              typeof message.leaseId === "string" &&
              message.hostId === CODEX_WORKBENCH_HOST_ID
            ) {
              pendingClaims.set(message.requestId, {
                type: message.type,
                leaseId: message.leaseId,
                ...(typeof message.generation === "number" ? { generation: message.generation } : {}),
              });
            }
          }
          return !ended;
        },
        diagnostic() {},
      },
    );
    const restoreSession = async () => {
      const rendererId = checkpoint.rendererId;
      if (rendererId === null) return;
      restoring = true;
      try {
        const control = (frame: object) => {
          const raw = JSON.stringify(frame);
          handler.message(raw, socketEncoder.encode(raw).byteLength);
        };
        control({ type: "hello", rendererId, protocolVersion: APP_HOST_PROTOCOL_VERSION });
        for (const lease of leases.values()) {
          const restored = new Promise<{ ok?: unknown; result?: unknown }>((resolve) => {
            restoreResponse = resolve;
          });
          control({
            type: "host/connect",
            hostId: CODEX_WORKBENCH_HOST_ID,
            leaseId: lease.id,
            requestId: "restore-lease",
          });
          const { ok, result } = await restored;
          if (ok !== true || (result as { generation?: number } | null)?.generation !== checkpoint.generation)
            throw new Error("Client Host lease cannot be restored");
        }
      } finally {
        restoreResponse = undefined;
        restoring = false;
      }
    };
    let pending = Promise.resolve();
    let frames = 0;
    let bytes = 0;
    const message = (data: string | ArrayBuffer) => {
      if (ended) return;
      if (typeof data !== "string") return close(1003, "Text frames required");
      if (data.length > MAX_PENDING_BYTES) return close(1009, "Client frame too large");
      const length = socketEncoder.encode(data).byteLength;
      if (length > MAX_PENDING_BYTES) return close(1009, "Client frame too large");
      if (frames >= MAX_PENDING_FRAMES || bytes + length > MAX_PENDING_BYTES)
        return close(1013, "Client input congested");
      bytes += length;
      frames++;
      pending = pending
        .then(async () => {
          if (ended) return;
          const current = await currentClientAttachment(this.#installation(), attachment);
          if (ended) return;
          if (!current) return close(1008, "Client admission revoked");
          await (restore ??= restoreSession());
          if (ended) return;
          handler.message(data, length);
        })
        .catch(() => close(1011, "Client socket unavailable"))
        .finally(() => {
          frames--;
          bytes -= length;
        });
      this.ctx.waitUntil(pending);
      return pending;
    };
    return { message, close };
  }

  #access(
    attachment: ClientAttachment,
    emit: (frame: string) => void,
    canTurn: boolean,
    turnLost: () => void,
    terminalLost: () => void,
    initiallyReady: boolean,
    rememberInitialized: () => void,
  ) {
    const delivery = new AbortController();
    const live = () => !delivery.signal.aborted;
    const streams = new Map<string, { threadId: string; detach: () => void }>();
    const claimStream: ClaimTurnStream = (threadId, turnId, detach) => {
      const key = JSON.stringify([threadId, turnId]);
      if (streams.has(key)) return;
      const reader = { threadId, detach };
      streams.set(key, reader);
      return () => {
        if (streams.get(key) === reader) streams.delete(key);
      };
    };
    const canTerminal = canTurn && this.env.OPENCRAFT_WORKSPACE_CODEX_ISOLATE_ACTORS === "true";
    const canOpenArchivedHistory = canTurn && this.env.OPENCRAFT_WORKSPACE_CODEX_SNAPSHOTS === "true";
    const canFiles = canTerminal && this.env.OPENCRAFT_WORKSPACE_CODEX_FILES === "true";
    const canProjects = canFiles && this.env.OPENCRAFT_WORKSPACE_CODEX_PROJECTS === "true";
    let initialized = initiallyReady;
    let terminal: ReturnType<typeof connectClientTerminal> | undefined;
    return {
      receive: async (frame: string): Promise<true> => {
        const request = parseJsonRpcMessage(frame);
        if (!live() || !isJsonRpcRequest(request)) return true;
        const { id, method, params } = request;
        if (method === "initialize") {
          rememberInitialized();
          initialized = true;
          const methods = ["initialize", "thread/read"];
          if (this.env.OPENCRAFT_WORKSPACE_CODEX_DEFAULT) methods.push("thread/list", "thread/start");
          if (canTurn)
            methods.push(
              "model/list",
              "thread/resume",
              "thread/turns/list",
              "thread/items/list",
              "thread/fork",
              "thread/name/set",
              "thread/archive",
              "thread/unarchive",
              "thread/settings/update",
              "thread/unsubscribe",
              "turn/start",
              "turn/steer",
              "turn/interrupt",
              SHARED_INTERACTIONS_READ,
              SHARED_INTERACTIONS_RESPOND,
            );
          if (canTerminal) methods.push(...HOST_TERMINAL_METHODS);
          if (canFiles) methods.push(...WORKSPACE_FILE_METHODS);
          if (canProjects) methods.push(...WORKSPACE_PROJECT_METHODS);
          emit(
            JSON.stringify({
              id,
              result: {
                userAgent: "OpenCraft Workspace Codex",
                capabilities: {
                  extensions: {
                    [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { version: 1, methods, clientDynamicTools: false },
                    ...(canFiles
                      ? {
                          [WORKSPACE_PLACEMENT_EXTENSION]: {
                            fileScopeVersion: 1,
                            ...(canProjects ? { projectDirectoryRoot: PROJECTLESS_WORKSPACE } : {}),
                          },
                        }
                      : {}),
                    ...(canTerminal
                      ? {
                          [OPENCRAFT_TERMINAL_EXTENSION]: {
                            version: 1,
                            available: false,
                            recovery: false,
                            selection: "per-request",
                            draftScopeOnThreadStart: true,
                          },
                        }
                      : {}),
                    ...(this.env.OPENCRAFT_WORKSPACE_CODEX_DEFAULT
                      ? {
                          [OPENCRAFT_RESUME_HISTORY_EXTENSION]: {
                            version: 1,
                            mode: canTurn ? "paginated" : "legacy",
                            ...(canTurn ? { observeActiveTurns: true, initialReadPage: true } : {}),
                          } satisfies OpenCraftResumeHistoryCapability,
                        }
                      : {}),
                    ...(canTurn
                      ? {
                          [OPENCRAFT_MODEL_CATALOG_REVALIDATION_EXTENSION]: { version: 1 },
                          [SHARED_INTERACTIONS_EXTENSION]: { version: 1 },
                          [OPENCRAFT_THREAD_START_DURABILITY_EXTENSION]: OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
                          [OPENCRAFT_THREAD_FOLLOW_UP_EXTENSION]: { version: 1, queue: false, directTurnStart: true },
                          [OPENCRAFT_THREAD_LIFECYCLE_EXTENSION]: {
                            version: 1,
                            fork: true,
                            rename: true,
                            archive: true,
                            ...(canTerminal ? { archiveStateInRead: true } : {}),
                            ...(canOpenArchivedHistory ? { openArchivedHistory: true } : {}),
                            sideChatSettings: true,
                            unsubscribe: true,
                          },
                        }
                      : {}),
                  },
                },
              },
            }),
          );
          return true;
        }
        if (canProjects && initialized && isWorkspaceProjectMethod(method, params)) {
          const operation = this.#projects(attachment, id, method, params, delivery.signal, emit);
          this.ctx.waitUntil(operation);
          await operation;
          return true;
        }
        if (canFiles && initialized && isWorkspaceFileMethod(method)) {
          const operation = this.#files(attachment, id, method, params, delivery.signal, emit);
          this.ctx.waitUntil(operation);
          await operation;
          return true;
        }
        if (canTerminal && initialized && isHostTerminalMethod(method)) {
          const target = {
            installation: this.#installation(),
            hosts: this.env.WORKSPACE_HOST,
            attachment,
            signal: delivery.signal,
          };
          if (!terminal && (method === "process/spawn" || method === "process/attach")) {
            const connection = connectClientTerminal({
              ...target,
              emit,
              lost: terminalLost,
            });
            terminal = connection;
            void connection.catch(() => {
              if (terminal === connection) terminal = undefined;
            });
          }
          const reply =
            method === "process/list"
              ? readClientTerminalInventory(target, request)
              : terminal?.then((connection) => connection.request(request));
          if (!reply) {
            emit(rpcError(id, -32004, "Terminal has no active attachment"));
            return true;
          }
          const operation = reply
            .then((frame) => {
              if (live()) emit(frame);
            })
            .catch(() => {
              if (live()) emit(rpcError(id, -32000, "Hands terminal unavailable"));
            });
          this.ctx.waitUntil(operation);
          await operation;
          return true;
        }
        if (
          (method === "model/list" && canTurn) ||
          (method === "thread/list" && this.env.OPENCRAFT_WORKSPACE_CODEX_DEFAULT)
        ) {
          const operation = this.#catalog(method, attachment, id, params, (frame) => {
            if (live()) emit(frame);
          });
          this.ctx.waitUntil(operation);
          await operation;
          return true;
        }
        if (
          (method === "thread/start" && this.env.OPENCRAFT_WORKSPACE_CODEX_DEFAULT) ||
          (method === "thread/fork" && canTurn)
        ) {
          const operation = this.#start(method, attachment, id, params, canTurn, canProjects, (frame) => {
            if (live()) emit(frame);
          });
          this.ctx.waitUntil(operation);
          await operation;
          return true;
        }
        if (method === "turn/start" && canTurn) {
          await new Promise<void>((settled) => {
            this.ctx.waitUntil(
              this.#turn(attachment, id, params, delivery.signal, emit, settled, turnLost, claimStream),
            );
          });
          return true;
        }
        if (method === "thread/resume" && canTurn) {
          const resume = parseCodexTurnOperation(method, params);
          if (resume?.kind !== "resume") {
            emit(rpcError(id, -32602, "Invalid Thread resume"));
            return true;
          }
          await new Promise<void>((settled) => {
            this.ctx.waitUntil(
              this.#resume(attachment, id, params, resume, delivery.signal, emit, settled, turnLost, claimStream),
            );
          });
          return true;
        }
        if (method === "thread/unsubscribe" && canTurn) {
          const threadId = parseCodexUnsubscribe(params);
          if (!threadId) {
            emit(rpcError(id, -32602, "Invalid Thread unsubscribe"));
            return true;
          }
          const authority = await codexTurnAuthority(this.#installation(), attachment, threadId).catch(() => null);
          if (!live()) return true;
          if (!authority) {
            emit(rpcError(id, -32004, "Thread unavailable"));
            return true;
          }
          let status: "notSubscribed" | "unsubscribed" = "notSubscribed";
          for (const [key, reader] of streams) {
            if (reader.threadId !== threadId) continue;
            streams.delete(key);
            reader.detach();
            status = "unsubscribed";
          }
          emit(JSON.stringify({ id, result: { status } }));
          return true;
        }
        if (
          canTurn &&
          (method === "turn/interrupt" ||
            method === "turn/steer" ||
            isCodexThreadMutation(method) ||
            method === SHARED_INTERACTIONS_READ ||
            method === SHARED_INTERACTIONS_RESPOND)
        ) {
          const operation = this.#control(attachment, id, method, params, live, emit);
          this.ctx.waitUntil(operation);
          await operation;
          return true;
        }
        if (
          method !== "thread/read" &&
          !(canTurn && (method === "thread/turns/list" || method === "thread/items/list"))
        ) {
          emit(rpcError(id, -32601, "Method unavailable on this Host"));
          return true;
        }
        const read = parseCodexHistoryRead(method, params);
        if (!read || (!canTurn && read.method === "thread/read" && read.params.initialTurnsPage !== undefined) ||
          (read.params.openArchivedHistory && !canOpenArchivedHistory)) {
          emit(rpcError(id, -32602, "Invalid Thread read"));
          return true;
        }
        if (this.#reads >= MAX_READS) {
          emit(rpcError(id, -32000, "Thread reader busy"));
          return true;
        }
        this.#reads++;
        const operation = (async () => {
          try {
            const result = await this.#read(attachment, read, live);
            if (!live()) return;
            if (result === null) emit(rpcError(id, -32004, "Conversation not found or unavailable"));
            else emit(JSON.stringify({ id, result }));
          } catch (error) {
            if (live())
              emit(
                error instanceof CodexHistoryReadError
                  ? rpcError(id, error.code, error.message, error.data)
                  : rpcError(id, -32000, "Thread reader unavailable"),
              );
          } finally {
            this.#reads--;
          }
        })();
        this.ctx.waitUntil(operation);
        await operation;
        return true;
      },
      project: () => null,
      close() {
        delivery.abort();
      },
    };
  }

  async #projects(
    attachment: ClientAttachment,
    id: JsonRpcId,
    method: string,
    params: unknown,
    signal: AbortSignal,
    emit: (frame: string) => void,
  ): Promise<void> {
    const send = (frame: string) => {
      if (!signal.aborted) emit(frame);
    };
    const call = parseWorkspaceProjectCall(method, params);
    if (!call) return send(rpcError(id, -32602, "Invalid workspace project request"));
    if (this.#reads >= MAX_READS) return send(rpcError(id, -32000, "Workspace project owner busy"));
    const missing = () => send(rpcError(id, -32004, "Workspace project unavailable"));
    this.#reads++;
    try {
      const workspace = await terminalWorkspace(this.#installation(), attachment);
      if (!workspace || signal.aborted) return missing();
      const hosts = this.env.WORKSPACE_HOST;
      const host = hosts.get(hosts.idFromName(workspaceHostObjectName(workspace)));
      const response = await host.fetch(
        new Request(`https://workspace.invalid${WORKSPACE_HOST_OBJECT_PREFIX}${WORKSPACE_PROJECTS_OPERATION}`, {
          method: "POST",
          headers: { "content-type": "application/json", [WORKSPACE_HOST_HEADER]: workspace },
          body: JSON.stringify({ attachment, ...call }),
        }),
      );
      if (!response.ok || signal.aborted) {
        await response.body?.cancel();
        if (response.status === 404 || signal.aborted) return missing();
        if (response.status === 400) return send(rpcError(id, -32602, "Invalid workspace project query"));
        if (response.status === 422) return send(rpcError(id, -32602, "Project configuration unavailable"));
        throw Error("Workspace project operation unavailable");
      }
      const result = ((await response.json()) as { result?: unknown } | null)?.result;
      if (!isWorkspaceProjectResult(call.method, result)) throw Error("Invalid workspace project response");
      send(JSON.stringify({ id, result }));
    } catch {
      send(rpcError(id, -32000, "Workspace project operation unavailable"));
    } finally {
      this.#reads--;
    }
  }

  async #files(
    attachment: ClientAttachment,
    id: JsonRpcId,
    method: string,
    params: unknown,
    signal: AbortSignal,
    emit: (frame: string) => void,
  ): Promise<void> {
    const send = (frame: string) => {
      if (!signal.aborted) emit(frame);
    };
    const call = parseWorkspaceFileCall(method, params);
    if (!call) return send(rpcError(id, -32602, "Invalid workspace file request"));
    if (this.#reads >= MAX_READS) return send(rpcError(id, -32000, "Workspace file owner busy"));
    const missing = () => send(rpcError(id, -32004, "Conversation not found or unavailable"));
    this.#reads++;
    try {
      const placement = await lookupCodexThread(this.#installation(), attachment, call.threadId);
      if (!placement || signal.aborted) return missing();
      const hosts = this.env.WORKSPACE_HOST;
      const host = hosts.get(hosts.idFromName(workspaceHostObjectName(placement.workspaceId)));
      const response = await host.fetch(
        new Request(`https://workspace.invalid${WORKSPACE_HOST_OBJECT_PREFIX}${WORKSPACE_FILES_OPERATION}`, {
          method: "POST",
          headers: { "content-type": "application/json", [WORKSPACE_HOST_HEADER]: placement.workspaceId },
          body: JSON.stringify({ attachment, placement, method, params }),
        }),
      );
      if (!response.ok || signal.aborted) {
        await response.body?.cancel();
        if (response.status === 404 || signal.aborted) return missing();
        throw Error("Workspace file owner unavailable");
      }
      const result = ((await response.json()) as { result?: unknown } | null)?.result;
      if (!isWorkspaceFileResult(call.method, result, call.threadId)) throw Error("Invalid workspace file response");
      send(JSON.stringify({ id, result }));
    } catch {
      send(rpcError(id, -32000, "Workspace file operation unavailable"));
    } finally {
      this.#reads--;
    }
  }

  #postTurnControl(attachment: ClientAttachment, placement: ThreadPlacementReceipt, method: string, params: unknown) {
    const hosts = this.env.WORKSPACE_HOST;
    const host = hosts.get(hosts.idFromName(workspaceHostObjectName(placement.workspaceId)));
    return host.fetch(
      new Request(`https://workspace.invalid${WORKSPACE_HOST_OBJECT_PREFIX}${WORKSPACE_CODEX_CONTROL_OPERATION}`, {
        method: "POST",
        headers: { "content-type": "application/json", [WORKSPACE_HOST_HEADER]: placement.workspaceId },
        body: JSON.stringify({ attachment, placement, method, params }),
      }),
    );
  }

  async #resume(
    attachment: ClientAttachment,
    id: JsonRpcId,
    params: unknown,
    resume: CodexResume,
    delivery: AbortSignal,
    emit: (frame: string) => void,
    settled: () => void,
    turnLost: () => void,
    claimStream: ClaimTurnStream,
  ): Promise<void> {
    const reader = new AbortController();
    const signal = AbortSignal.any([delivery, reader.signal]);
    const send = (frame: string) => {
      if (!signal.aborted) emit(frame);
    };
    const unavailable = () => send(rpcError(id, -32004, "Conversation not found or unavailable"));
    const authorize = () => codexTurnAuthority(this.#installation(), attachment, resume.threadId);
    let turnId: string | undefined;
    let releaseStream: (() => void) | undefined;
    try {
      const authority = await authorize();
      if (!authority || signal.aborted) return unavailable();
      const { placement } = authority;
      const current = async () => {
        const answer = await authorize();
        return !!answer && sameThreadPlacement(answer.placement, placement) && !signal.aborted;
      };
      const response = await this.#postTurnControl(attachment, placement, "thread/resume", params);
      if (!response.ok || !response.body || signal.aborted) {
        await response.body?.cancel();
        if (response.status === 404 || signal.aborted) return unavailable();
        throw new Error("Thread resume unavailable");
      }
      if (response.headers.get("content-type") !== CODEX_TURN_STREAM_TYPE) {
        const result: unknown = await response.json();
        if (!matchesCodexResume(result, resume) || !(await current())) return unavailable();
        send(JSON.stringify({ id, result }));
        return;
      }
      for await (const value of readCodexStream(response.body, signal, 4 * 1024 * 1024)) {
        if (!(await current())) {
          if (!turnId) unavailable();
          else if (!signal.aborted) turnLost();
          return;
        }
        if (!turnId) {
          const packet = value as { turnId?: unknown; result?: unknown } | null;
          if (
            typeof packet?.turnId !== "string" ||
            !packet.turnId ||
            packet.turnId.length > 512 ||
            !matchesCodexResume(packet.result, resume)
          )
            throw new Error("Invalid Thread resume receipt");
          turnId = packet.turnId;
          // A resume always has its own receipt. Only the first validated
          // stream for this Turn delivers events on the connection.
          releaseStream = claimStream(resume.threadId, turnId, () => reader.abort());
          send(JSON.stringify({ id, result: packet.result }));
          settled();
          if (!releaseStream) return;
        } else {
          const event = scopedCodexTurnEvent(value, resume.threadId, turnId);
          if (!event) throw new Error("Invalid resumed Turn event");
          send(JSON.stringify(event));
          if (event.method === "turn/completed") return;
        }
      }
      if (!signal.aborted) throw new Error("Resumed Turn stream closed");
    } catch {
      if (!turnId) send(rpcError(id, -32000, "Thread resume unavailable"));
      else if (!signal.aborted) turnLost();
    } finally {
      releaseStream?.();
      settled();
    }
  }

  async #control(
    attachment: ClientAttachment,
    id: JsonRpcId,
    method: string,
    params: unknown,
    live: () => boolean,
    emit: (frame: string) => void,
  ): Promise<void> {
    const operation = parseCodexTurnOperation(method, params);
    const send = (frame: string) => {
      if (live()) emit(frame);
    };
    const subject = isCodexThreadMutation(method) ? "Thread" : "Turn";
    const unavailable = () => send(rpcError(id, -32004, `${subject} unavailable`));
    if (!operation) return send(rpcError(id, -32602, `Invalid ${subject} operation`));
    let forwarded = false;
    try {
      const authorize = () => codexTurnAuthority(this.#installation(), attachment, operation.threadId);
      const authority = await authorize();
      if (!authority || !live()) return unavailable();
      const { placement } = authority;
      forwarded = true;
      const response = await this.#postTurnControl(attachment, placement, method, params);
      if (response.status === 404) {
        await response.body?.cancel();
        return unavailable();
      }
      if (operation.kind === "thread-mutation" && response.status === 423) {
        await response.body?.cancel();
        return send(
          JSON.stringify({
            id,
            error: {
              code: -32009,
              message: "Thread operation was not submitted",
              data: { notSubmitted: true },
            },
          }),
        );
      }
      if (!response.ok && response.status !== 422) {
        await response.body?.cancel();
        throw new Error("Turn operation outcome unknown");
      }
      const result: unknown = await response.json();
      const current = await authorize();
      if (!current || !sameThreadPlacement(current.placement, placement)) return unavailable();
      if (response.status === 422) {
        const code = (result as { interactionError?: { code?: unknown } } | null)?.interactionError?.code;
        if (typeof code !== "string") throw new Error("Invalid interaction refusal");
        send(JSON.stringify({ id, error: { code: -32083, message: "Interaction unavailable", data: { code } } }));
        return;
      }
      if (
        operation.kind === "read-interactions" &&
        parseSharedInteractionSnapshot(result)?.threadId !== operation.threadId
      )
        throw new Error("Invalid interaction snapshot");
      if (operation.kind === "steer") {
        const receipt = parseCodexSteerReceipt(result, operation.expectedTurnId);
        if (!receipt) throw new Error("Invalid steer receipt");
        send(JSON.stringify({ id, result: receipt }));
        return;
      }
      if (operation.kind === "thread-mutation") {
        const receipt = parseCodexThreadMutationReceipt(result, operation);
        if (!receipt) throw new Error("Invalid Thread mutation receipt");
        return send(JSON.stringify({ id, result: receipt }));
      }
      if (operation.kind === "respond-interaction") {
        const receipt = result as { disposition?: unknown; snapshot?: unknown } | null;
        if (
          !receipt ||
          !["submitted", "already-submitted", "resolved"].includes(String(receipt.disposition)) ||
          parseSharedInteractionSnapshot(receipt.snapshot)?.threadId !== operation.threadId
        )
          throw new Error("Invalid interaction receipt");
      }
      send(JSON.stringify({ id, result }));
    } catch {
      if (!forwarded || operation.kind === "read-interactions")
        return send(rpcError(id, -32000, `${subject} operation unavailable`));
      send(
        JSON.stringify({
          id,
          error: {
            code: -32086,
            message: `${subject} operation outcome unconfirmed`,
            data: { resultUnknown: true },
          },
        }),
      );
    }
  }

  async #turn(
    attachment: ClientAttachment,
    id: JsonRpcId,
    params: unknown,
    connection: AbortSignal,
    emit: (frame: string) => void,
    settled: () => void,
    turnLost: () => void,
    claimStream: ClaimTurnStream,
  ): Promise<void> {
    const reader = new AbortController();
    const delivery = AbortSignal.any([connection, reader.signal]);
    const live = () => !delivery.aborted;
    const turn = parseCodexTurn(params);
    const send = (frame: string) => {
      if (live()) emit(frame);
    };
    const refuse = (outcome: "denied" | "not-submitted" | "unknown") => {
      if (outcome === "denied") return send(rpcError(id, -32004, "Turn unavailable"));
      const unknown = outcome === "unknown";
      send(
        JSON.stringify({
          id,
          error: {
            code: unknown ? -32086 : -32085,
            message: unknown ? "Turn outcome unconfirmed" : "Turn was not submitted",
            data: unknown ? { resultUnknown: true } : { notSubmitted: true, forwarded: false },
          },
        }),
      );
    };
    let turnId: string | undefined;
    let releaseStream: (() => void) | undefined;
    try {
      if (!turn) {
        send(rpcError(id, -32602, "Invalid text Turn"));
        return;
      }
      const authorize = () => codexTurnAuthority(this.#installation(), attachment, turn.threadId);
      const authority = await authorize();
      if (!authority || !live()) return refuse("denied");
      const { placement } = authority;
      const hosts = this.env.WORKSPACE_HOST;
      const host = hosts.get(hosts.idFromName(workspaceHostObjectName(placement.workspaceId)));
      const response = await host.fetch(
        new Request(`https://workspace.invalid${WORKSPACE_HOST_OBJECT_PREFIX}${WORKSPACE_CODEX_TURN_OPERATION}`, {
          method: "POST",
          headers: { "content-type": "application/json", [WORKSPACE_HOST_HEADER]: placement.workspaceId },
          body: JSON.stringify({ attachment, placement, turn }),
        }),
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        if (response.status === 422) return send(rpcError(id, -32602, "Selected model unavailable"));
        return refuse(response.status === 404 ? "denied" : response.status === 429 ? "not-submitted" : "unknown");
      }
      if (!live()) {
        await response.body.cancel();
        return;
      }
      for await (const value of readCodexStream(response.body, delivery, 1024 * 1024)) {
        const packet = parseTurnStreamFrame(value, turn.threadId, turnId);
        if (!packet) throw new Error("Invalid Turn stream");
        if (!live()) return;
        const current = await authorize();
        if (!current || !sameThreadPlacement(current.placement, placement) || !live()) {
          if (!turnId) refuse("denied");
          else if (live()) turnLost();
          return;
        }
        if (packet.kind === "refused") return refuse(packet.outcome);
        if (packet.kind === "accepted") {
          turnId = packet.result.turn.id;
          releaseStream = claimStream(turn.threadId, turnId, () => reader.abort());
          send(JSON.stringify({ id, result: packet.result }));
          settled();
          if (!releaseStream) return;
        } else {
          send(JSON.stringify(packet.frame));
          if (packet.frame.method === "turn/completed") return;
        }
      }
      throw new Error("Turn stream ended without a terminal receipt");
    } catch {
      if (!turnId) refuse("unknown");
      else if (live()) turnLost();
    } finally {
      releaseStream?.();
      settled();
    }
  }

  async #catalog(
    method: "model/list" | "thread/list",
    attachment: ClientAttachment,
    id: JsonRpcId,
    raw: unknown,
    emit: (frame: string) => void,
  ) {
    const model = method === "model/list";
    const label = model ? "Model list" : "Thread list";
    const params = model ? parseCodexModelList(raw) : parseCodexThreadList(raw);
    if (!params) return emit(rpcError(id, -32602, `Invalid ${label.toLowerCase()}`));
    if (this.#reads >= MAX_READS) return emit(rpcError(id, -32000, `${label} reader busy`));
    this.#reads++;
    try {
      const path = model ? CODEX_MODEL_LIST_PATH : CODEX_THREAD_LIST_PATH;
      const response = await this.#installation().fetch(
        new Request(`https://installation.invalid${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attachment, params }),
        }),
      );
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 400) return emit(rpcError(id, -32602, `Invalid ${label.toLowerCase()}`));
        if ([401, 403, 404].includes(response.status)) return emit(rpcError(id, -32004, `${label} unavailable`));
        throw new Error(`${label} unavailable`);
      }
      const result: unknown = await response.json();
      if (!(model ? isCodexModelList(result) : parseCodexThreadPage(result, true))) throw new Error("Invalid catalog");
      emit(JSON.stringify({ id, result }));
    } catch {
      emit(rpcError(id, -32000, `${label} unavailable`));
    } finally {
      this.#reads--;
    }
  }

  async #start(
    method: "thread/start" | "thread/fork",
    attachment: ClientAttachment,
    id: JsonRpcId,
    params: unknown,
    canTurn: boolean,
    canProjects: boolean,
    emit: (frame: string) => void,
  ) {
    const call = parseCodexStartRequest({ attachment, requestId: id, options: params }, method);
    if (!call) {
      emit(
        rpcError(id, -32602, method === "thread/start" ? "Invalid projectless Thread start" : "Invalid Thread fork"),
      );
      return;
    }
    if ((call.options.historyMode && !canTurn) || (call.options.projectId !== undefined && !canProjects)) {
      emit(rpcError(id, -32602, "Thread configuration unavailable"));
      return;
    }
    const unknown = () =>
      emit(
        JSON.stringify({
          id,
          error: { code: -32086, message: "Thread creation outcome unconfirmed", data: { resultUnknown: true } },
        }),
      );
    try {
      const response = await this.#installation().fetch(
        new Request(`https://installation.invalid${CODEX_THREAD_START_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(call),
        }),
      );
      if (!response.ok) {
        if (response.status === 422) {
          const failure = (await response.json().catch(() => null)) as { error?: unknown } | null;
          emit(
            rpcError(
              id,
              -32602,
              failure?.error === "project_unavailable" ? "Selected project unavailable" : "Selected model unavailable",
            ),
          );
          return;
        }
        await response.body?.cancel();
        if ([401, 403, 404].includes(response.status)) emit(rpcError(id, -32004, "Thread creation unavailable"));
        else if (response.status === 429 || response.status === 503)
          emit(
            JSON.stringify({
              id,
              error: {
                code: -32085,
                message: response.status === 429 ? "Thread creator busy" : "Workspace unavailable",
                data: { notSubmitted: true, forwarded: false },
              },
            }),
          );
        else unknown();
        return;
      }
      const result: unknown = await response.json();
      const threadId = createdCodexThreadId(result, call.options.fork?.threadId);
      if (!threadId) return unknown();
      if (!(await lookupCodexThread(this.#installation(), attachment, threadId))) {
        emit(rpcError(id, -32004, "Thread creation unavailable"));
        return;
      }
      emit(JSON.stringify({ id, result }));
    } catch {
      unknown();
    }
  }

  async #read(attachment: ClientAttachment, read: CodexHistoryRead, live: () => boolean): Promise<unknown | null> {
    const { threadId } = read.params;
    const archivedError = () => new CodexHistoryReadError(CODEX_THREAD_ARCHIVED, "Thread is archived", {
      code: "THREAD_ARCHIVED",
    });
    const placement = await lookupCodexThread(this.#installation(), attachment, threadId);
    if (!placement || !live()) return null;
    const workspaces = this.env.WORKSPACE_HOST;
    const workspace = workspaces.get(workspaces.idFromName(workspaceHostObjectName(placement.workspaceId)));
    const response = await workspace.fetch(
      new Request(`https://workspace.invalid${WORKSPACE_HOST_OBJECT_PREFIX}${WORKSPACE_CODEX_READ_OPERATION}`, {
        method: "POST",
        headers: { "content-type": "application/json", [WORKSPACE_HOST_HEADER]: placement.workspaceId },
        body: JSON.stringify({ attachment, placement, method: read.method, read: read.params }),
      }),
    );
    if (!response.ok || !live()) {
      if (response.status === 425 && live()) {
        const history = (await response.json()) as { archived?: unknown } | null;
        const current = await lookupCodexThread(this.#installation(), attachment, threadId);
        if (!live() || !current || !sameThreadPlacement(current, placement)) return null;
        throw new CodexHistoryReadError(-32073, "History is unavailable while the workspace sleeps", {
          code: WORKSPACE_HISTORY_ASLEEP,
          ...(typeof history?.archived === "boolean" ? { archived: history.archived } : {}),
        });
      }
      await response.body?.cancel();
      if (!live() || response.status === 404) return null;
      if (response.status === 423) {
        const current = await lookupCodexThread(this.#installation(), attachment, threadId);
        if (!live() || !current || !sameThreadPlacement(current, placement)) return null;
        throw archivedError();
      }
      if (response.status === 410)
        throw new CodexHistoryReadError(-32602, "History preview cursor expired", {
          code: HISTORY_PREVIEW_CURSOR_EXPIRED,
        });
      if (response.status === 413)
        throw new CodexHistoryReadError(CODEX_HISTORY_RESPONSE_TOO_LARGE, "History response too large", {
          code: "HISTORY_RESPONSE_TOO_LARGE", retryable: false,
        });
      if (response.status === 501)
        throw new CodexHistoryReadError(-32601, "History method unavailable for this Thread");
      throw new Error("Workspace Thread read failed");
    }
    const result: unknown = await response.json();
    if (!isCodexHistoryResult(read, result)) throw new Error("Invalid workspace Thread read");
    if (!live()) return null;
    const ordinaryBody = readsOrdinaryCodexHistoryBody(read);
    const current = await lookupCodexThread(this.#installation(), attachment, threadId, {
      archiveState: ordinaryBody || read.method === "thread/read",
    });
    if (!current || !sameThreadPlacement(current, placement) || !live()) return null;
    if (ordinaryBody && current.archived === true) throw archivedError();
    if (read.method !== "thread/read" || current.archived === undefined) return result;
    const responseBody = result as { thread: Record<string, unknown> };
    if (typeof responseBody.thread.archived === "boolean") return result;
    return { ...responseBody, thread: { ...responseBody.thread, archived: current.archived } };
  }
}
