import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  parseJsonRpcMessage,
  type JsonRpcId,
  type JsonRpcRequest,
} from "@opencraft/appserver-protocol";
import {
  WORKSPACE_HOST_HEADER,
  WORKSPACE_HOST_OBJECT_PREFIX,
  WORKSPACE_TERMINAL_COMMAND_BYTES,
  WORKSPACE_TERMINAL_COMMAND_OPERATION,
  WORKSPACE_TERMINAL_OPERATION,
  WORKSPACE_TERMINAL_SESSION_HEADER,
  workspaceHostObjectName,
} from "../workspace-host-routes.js";
import type { InstallationCoreNamespace, WorkspaceHostNamespace } from "./bindings.js";
import { CLIENT_ATTACHMENT_HEADER, type ClientAttachment } from "./client-attachment.js";
import { terminalWorkspace } from "./terminal-authority.js";

type OwnerSocket = WebSocket & { accept(): void };

interface ClientTerminalTarget {
  readonly installation: ReturnType<InstallationCoreNamespace["get"]>;
  readonly hosts: WorkspaceHostNamespace;
  readonly attachment: ClientAttachment;
  readonly signal: AbortSignal;
}

async function terminalRoute({ installation, hosts, attachment, signal }: ClientTerminalTarget) {
  const workspace = await terminalWorkspace(installation, attachment);
  signal.throwIfAborted();
  if (!workspace) throw new Error("Terminal authority unavailable");
  return {
    host: hosts.get(hosts.idFromName(workspaceHostObjectName(workspace))),
    headers: { [WORKSPACE_HOST_HEADER]: workspace, [CLIENT_ATTACHMENT_HEADER]: JSON.stringify(attachment) },
  };
}

function commandFrame(request: JsonRpcRequest) {
  const frame = JSON.stringify(request);
  if (new TextEncoder().encode(frame).byteLength > WORKSPACE_TERMINAL_COMMAND_BYTES)
    throw new Error("Terminal request exceeds its budget");
  return frame;
}

async function terminalReply(response: Response, requestId: JsonRpcId) {
  const reply = await response.text();
  const message = parseJsonRpcMessage(reply);
  if (isJsonRpcRequest(message) || isJsonRpcNotification(message) || message.id !== requestId)
    throw new Error("Invalid terminal response");
  return reply;
}

const commandUrl = `https://workspace.invalid${WORKSPACE_HOST_OBJECT_PREFIX}${WORKSPACE_TERMINAL_COMMAND_OPERATION}`;

export async function readClientTerminalInventory(options: ClientTerminalTarget, request: JsonRpcRequest) {
  const { host, headers } = await terminalRoute(options);
  const response = await host.fetch(
    new Request(commandUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: commandFrame(request),
    }),
  );
  if (!response.ok || options.signal.aborted) {
    await response.body?.cancel();
    throw new Error("Terminal inventory unavailable");
  }
  return terminalReply(response, request.id);
}

export async function connectClientTerminal(
  options: ClientTerminalTarget & {
    readonly emit: (frame: string) => void;
    readonly lost: () => void;
  },
) {
  const { signal, emit, lost } = options;
  const { host, headers: routeHeaders } = await terminalRoute(options);
  const sessionId = crypto.randomUUID();
  const headers = {
    ...routeHeaders,
    [WORKSPACE_TERMINAL_SESSION_HEADER]: sessionId,
  };
  const response = await host.fetch(
    new Request(`https://workspace.invalid${WORKSPACE_HOST_OBJECT_PREFIX}${WORKSPACE_TERMINAL_OPERATION}`, {
      headers: { ...headers, upgrade: "websocket" },
    }),
  );
  const socket = (response as Response & { webSocket?: OwnerSocket }).webSocket;
  if (!socket || response.status !== 101) {
    await response.body?.cancel();
    throw new Error("Workspace terminal connection unavailable");
  }
  socket.accept();
  const pending = new Set<JsonRpcId>();
  let ended = false;
  const close = (unexpected: boolean) => {
    if (ended) return;
    ended = true;
    signal.removeEventListener("abort", detach);
    pending.clear();
    try {
      socket.close(unexpected ? 1011 : 1000);
    } catch {
      /* Already closed. */
    }
    if (unexpected) lost();
  };
  const detach = () => close(false);
  signal.addEventListener("abort", detach, { once: true });
  if (signal.aborted) {
    detach();
    signal.throwIfAborted();
  }
  socket.addEventListener("message", ({ data }) => {
    if (ended) return;
    try {
      if (typeof data !== "string" || data.length > 8 * 1024 * 1024) throw new Error("Invalid terminal reply");
      const message = parseJsonRpcMessage(data);
      if (isJsonRpcNotification(message)) {
        if (message.method === "process/outputDelta" || message.method === "process/exited") emit(data);
        return;
      }
      throw new Error("Terminal event channel unexpectedly returned a command reply");
    } catch {
      close(true);
    }
  });
  socket.addEventListener("close", () => close(true));
  socket.addEventListener("error", () => close(true));
  return {
    async request(request: JsonRpcRequest) {
      signal.throwIfAborted();
      if (ended || pending.size >= 16 || pending.has(request.id)) throw new Error("Terminal request unavailable");
      const frame = commandFrame(request);
      pending.add(request.id);
      try {
        // An individual binding request has its own Cloudflare invocation.
        // The private WebSocket only delivers observations from Hands.
        const response = await host.fetch(
          new Request(commandUrl, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: frame,
          }),
        );
        if (!response.ok || ended) {
          await response.body?.cancel();
          if (response.status === 404) close(true);
          throw new Error("Terminal request unavailable");
        }
        return await terminalReply(response, request.id);
      } finally {
        pending.delete(request.id);
      }
    },
  };
}
