import {
  isHostTerminalMethod,
  isJsonRpcRequest,
  isTerminalResourceScopeId,
  parseJsonRpcMessage,
  type JsonRpcId,
  type ProcessSnapshot,
} from "@opencraft/appserver-protocol";
import { TerminalCapacityError, type TerminalOwnerLink } from "@opencraft/local-agent-host/terminal-owner-link";
import { WORKSPACE_TERMINAL_COMMAND_BYTES } from "../workspace-host-routes.js";
import type { TerminalAdmission, TerminalScope } from "./terminal-authority.js";
import { PROJECTLESS_WORKSPACE, WORKSPACE_DIRECTORY } from "./workspace-paths.js";

const OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_REQUESTS = 16;
const MAX_QUEUED_EVENTS = 64;

type OwnerSocket = WebSocket & { accept(): void };
type SocketRuntime = typeof globalThis & {
  WebSocketPair: new () => { 0: WebSocket; 1: OwnerSocket };
};
type TerminalEvent = { method: string; params: unknown; scope: TerminalScope };
type WatchedTerminal = { scope: TerminalScope; projectId: string | null };
type Inventory = { processes: Array<Omit<ProcessSnapshot, "output">> };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function terminalScope(threadId: string | null, resourceOwnerId?: unknown): TerminalScope {
  return {
    threadId,
    draftScopeId: threadId === null && isTerminalResourceScopeId(resourceOwnerId) ? resourceOwnerId : null,
  };
}

function spawnEnvironment(params: Record<string, unknown>) {
  const requested = params.env == null ? {} : record(params.env);
  if (!requested) throw new Error("Invalid terminal environment");
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(requested)) {
    // Hands validates the keys and applies them to its process environment.
    if (typeof value === "string") entries.push([key, value]);
    else if (value !== null) throw new Error("Invalid terminal environment");
  }
  return Object.fromEntries(entries);
}

export interface WorkspaceTerminalOptions {
  readonly owner: string;
  readonly hostId: string;
  readonly running: () => boolean;
  readonly openOwner: (onNotification: (method: string, params: unknown) => void) => Promise<TerminalOwnerLink>;
  readonly authorize: (scope: TerminalScope) => Promise<TerminalAdmission>;
  readonly authorizeProject?: (projectId: string, cwd: string, threadId: string | null) => Promise<boolean>;
  readonly waitUntil: (work: Promise<unknown>) => void;
}

function workspaceTerminalSession(
  options: WorkspaceTerminalOptions,
  events?: {
    send(frame: string): void;
    close(code: number, reason: string): void;
  },
) {
  const watches = new Map<string, WatchedTerminal>();
  let link: TerminalOwnerLink | undefined;
  let ended = false;
  let queue = Promise.resolve();
  let requests = 0;
  let inputBytes = 0;
  let queuedEvents: TerminalEvent[] = [];
  let flushing = false;

  const detach = () => {
    const current = link;
    link = undefined;
    if (current) options.waitUntil(current.close().catch(() => undefined));
  };
  const detachIdle = () => {
    if (!requests && !watches.size && !flushing) detach();
  };
  const close = (code: number, reason: string) => {
    if (ended) return;
    ended = true;
    watches.clear();
    queuedEvents = [];
    detach();
    events?.close(code, reason);
  };
  const send = (message: unknown) => {
    if (ended || !events) return;
    const frame = JSON.stringify(message);
    try {
      events.send(frame);
    } catch {
      close(1011, "Terminal connection unavailable");
    }
  };
  const fault = (id: JsonRpcId, code: number, message = "Terminal unavailable for this account or workspace") =>
    JSON.stringify({ id, error: { code, message } });

  const onNotification = (method: string, params: unknown) => {
    const handle = record(params)?.processHandle;
    if (ended || typeof handle !== "string" || (method !== "process/outputDelta" && method !== "process/exited"))
      return;
    const scope = watches.get(handle)?.scope;
    if (!scope) return;
    if (method === "process/exited") watches.delete(handle);
    if (queuedEvents.length >= MAX_QUEUED_EVENTS) return close(1013, "Terminal output congested");
    queuedEvents.push({ method, params, scope });
    if (flushing) return;
    flushing = true;
    options.waitUntil(
      (async () => {
        while (queuedEvents.length && !ended) {
          const current = queuedEvents;
          queuedEvents = [];
          let previousScope: string | undefined;
          let admission: TerminalAdmission = "denied";
          for (const { method, params, scope } of current) {
            const key = JSON.stringify([scope.threadId, scope.draftScopeId]);
            if (key !== previousScope) {
              admission = await options.authorize(scope);
              previousScope = key;
            }
            if (admission === "denied") return close(1008, "Terminal admission revoked");
            if (admission === "active" || method === "process/exited") send({ method, params });
          }
        }
      })()
        .catch(() => close(1011, "Terminal authority unavailable"))
        .finally(() => {
          flushing = false;
          detachIdle();
        }),
    );
  };

  const connect = async () => {
    if (link) return link;
    const opened = await options.openOwner(onNotification);
    if (ended || opened.isClosed) {
      await opened.close();
      throw new Error("Terminal connection unavailable");
    }
    link = opened;
    void opened.closed.then(() => {
      if (link === opened) close(1012, "Hands terminal unavailable");
    });
    return opened;
  };

  const dispatch = async (frame: string) => {
    const request = parseJsonRpcMessage(frame);
    if (!isJsonRpcRequest(request)) throw Error("Terminal request required");
    const { id, method } = request;
    if (!isHostTerminalMethod(method)) return fault(id, -32601);
    const params = request.params === undefined && method === "process/list" ? {} : record(request.params);
    const threadId = params?.threadId ?? null;
    const projectId = params?.projectId ?? null;
    if (
      !params ||
      (projectId !== null &&
        (!options.authorizeProject ||
          typeof projectId !== "string" ||
          projectId.length < 1 ||
          projectId.length > 512 ||
          /[\x00-\x1f\x7f]/u.test(projectId))) ||
      (threadId !== null && (typeof threadId !== "string" || !threadId.length || threadId.length > 512))
    )
      return fault(id, -32602);
    const handle = params.processHandle;
    if (method !== "process/list" && (typeof handle !== "string" || !handle.length || handle.length > 256))
      return fault(id, -32602);
    let launch: { cwd: string; env: Record<string, string> } | undefined;
    if (method === "process/spawn") {
      const cwd = params.cwd ?? PROJECTLESS_WORKSPACE;
      if (
        typeof cwd !== "string" ||
        cwd.includes("\0") ||
        !(cwd === WORKSPACE_DIRECTORY || cwd.startsWith(WORKSPACE_DIRECTORY + "/")) ||
        params.tty !== true ||
        !Array.isArray(params.command) ||
        !params.command.length ||
        typeof params.command[0] !== "string" ||
        !params.command[0] ||
        (params.resourceOwnerId != null && !isTerminalResourceScopeId(params.resourceOwnerId))
      )
        return fault(id, -32602);
      try {
        launch = { cwd, env: spawnEnvironment(params) };
      } catch {
        return fault(id, -32602);
      }
    }
    let scope = terminalScope(threadId, launch ? params.resourceOwnerId : undefined);
    const current = async () => (await options.authorize(scope)) === "active";
    try {
      if (!(await current()) || ended) return fault(id, -32004);
      if (method !== "process/spawn" && !options.running())
        return method === "process/list" ? JSON.stringify({ id, result: { processes: [] } }) : fault(id, -32004);
      if (launch && projectId !== null && !(await options.authorizeProject?.(projectId, launch.cwd, threadId)))
        return fault(id, -32004);
      const terminal = await connect();
      if (!(await current()) || ended) return fault(id, -32004);
      const identity = {
        owner: options.owner,
        quotaOwner: options.owner,
        scope: { account: options.owner, hostId: options.hostId, threadId, projectId },
      };
      const inventory = async () => {
        const value = (await terminal.dispatch("process/list", {}, identity)) as Inventory;
        return value.processes.filter(
          (entry) => entry.context?.threadId === threadId && entry.context.projectId === projectId,
        );
      };
      let result: unknown;
      if (method === "process/list") {
        const processes = await inventory();
        const checks = new Map<string, Promise<TerminalAdmission>>();
        const visible = await Promise.all(
          processes.map(async (entry) => {
            const entryScope = terminalScope(threadId, entry.context?.resourceOwnerId);
            const alias = entryScope.draftScopeId;
            if (alias === null) return entry;
            if (!checks.has(alias)) checks.set(alias, options.authorize(entryScope));
            return (await checks.get(alias)) === "active" ? entry : null;
          }),
        );
        result = { processes: visible.filter((entry) => entry !== null) };
      } else if (launch && typeof handle === "string") {
        result = await terminal.dispatch(
          method,
          { ...params, cwd: launch.cwd },
          { ...identity, env: launch.env },
          undefined,
          () => watches.set(handle, { scope, projectId }),
        );
      } else if (method === "process/attach" && typeof handle === "string") {
        const watched = watches.get(handle);
        if (watched?.scope.threadId === threadId && watched.projectId === projectId) scope = watched.scope;
        else {
          const entry = (await inventory()).find((entry) => entry.processHandle === handle);
          if (!entry) return fault(id, -32004);
          scope = terminalScope(threadId, entry.context?.resourceOwnerId);
        }
        if (!(await current()) || ended) return fault(id, -32004);
        result = await terminal.dispatch(method, params, identity, undefined, () =>
          watches.set(handle, { scope, projectId }),
        );
        if ((result as ProcessSnapshot).phase !== "running") watches.delete(handle);
      } else {
        const watched = typeof handle === "string" ? watches.get(handle) : undefined;
        if (!watched || watched.scope.threadId !== threadId || watched.projectId !== projectId)
          return fault(id, -32004);
        scope = watched.scope;
        if (!(await current()) || ended) return fault(id, -32004);
        result = await terminal.dispatch(method, params, identity);
      }
      if (!(await current())) return fault(id, -32004);
      return JSON.stringify({ id, result });
    } catch (error) {
      if (error instanceof TerminalCapacityError) return fault(id, -32029, error.message);
      return fault(id, -32000);
    }
  };

  return {
    close,
    async request(frame: string, bytes: number) {
      if (ended || requests >= MAX_QUEUED_REQUESTS || inputBytes + bytes > WORKSPACE_TERMINAL_COMMAND_BYTES)
        throw Error("Terminal input unavailable");
      requests++;
      inputBytes += bytes;
      const pending = queue.then(() => {
        if (ended) throw Error("Terminal session closed");
        return dispatch(frame);
      });
      queue = pending.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await pending;
      } finally {
        requests--;
        inputBytes -= bytes;
        detachIdle();
      }
    },
  };
}

export function acceptWorkspaceTerminal(options: WorkspaceTerminalOptions & { readonly onClose: () => void }) {
  const { WebSocketPair } = globalThis as SocketRuntime;
  const { 0: client, 1: socket } = new WebSocketPair();
  socket.accept();
  const session = workspaceTerminalSession(options, {
    send(frame) {
      if (frame.length > OUTPUT_BYTES || socket.bufferedAmount >= OUTPUT_BYTES)
        return session.close(1013, "Terminal output congested");
      socket.send(frame);
    },
    close(code, reason) {
      options.onClose();
      try {
        socket.close(code, reason);
      } catch {
        /* The peer already disconnected. */
      }
    },
  });
  socket.addEventListener("message", () => session.close(1002, "Terminal event channel is read-only"));
  socket.addEventListener("close", () => session.close(1000, "Terminal detached"));
  socket.addEventListener("error", () => session.close(1011, "Terminal connection unavailable"));
  return {
    response: new Response(null, { status: 101, webSocket: client } as ResponseInit),
    close: () => session.close(1012, "Terminal workspace closed"),
    request: session.request,
  };
}

export async function readWorkspaceTerminalInventory(options: WorkspaceTerminalOptions, frame: string, bytes: number) {
  const request = parseJsonRpcMessage(frame);
  if (!isJsonRpcRequest(request) || request.method !== "process/list") return null;
  const session = workspaceTerminalSession(options);
  try {
    return await session.request(frame, bytes);
  } finally {
    session.close(1000, "Terminal inventory complete");
  }
}
