import { Service, type Context } from "@deepseek-ai/cordis";
import type { AppServerConnection, JsonRpcRequest, JsonRpcResponse } from "../types/appserver.ts";
import type {
  PreparedCommandRequest,
  PreparedHostProcessRequest,
  RoutedProcessNotification,
  TransparentCommandProcess,
  TransparentHostProcess,
  TransparentProcessBridgePort,
  TransparentProcessFilesystemPort,
  TransparentProcessState,
} from "../types/transparent-process.ts";
import { rpcParams } from "../types/transparent-process.ts";
import {
  COMMAND_EXEC_METHODS,
  HOST_PROCESS_METHODS,
  decodeUtf8Base64,
  encodeUtf8Base64,
} from "./transparent-thread-routing.ts";

const INTERNAL_PREFIX = "hypernode:transparent:";

function stringParam(message: JsonRpcRequest | JsonRpcResponse, key: string): string | null {
  const value = rpcParams(message)[key];
  return typeof value === "string" ? value : null;
}

function withParam(message: JsonRpcRequest, key: string, value: string): JsonRpcRequest {
  return { ...message, params: { ...rpcParams(message), [key]: value } };
}

export class TransparentProcessBridgeService extends Service implements TransparentProcessBridgePort {
  private sequence = 0;

  constructor(ctx: Context) {
    super(ctx, "transparentProcessBridge");
  }

  private nextId(kind: string): string {
    this.sequence += 1;
    return `${INTERNAL_PREFIX}${kind}:${this.sequence}`;
  }

  private resolveVirtualWorkingDirectory(
    path: string,
    filesystem: TransparentProcessFilesystemPort,
  ): string | null {
    if (!path.startsWith("/")) return null;
    let normalized: string;
    try {
      normalized = filesystem.normalize(path);
    } catch {
      return null;
    }
    return filesystem.owns(normalized) ? normalized : null;
  }

  prepareCommandRequest(
    state: TransparentProcessState,
    connection: AppServerConnection,
    message: JsonRpcRequest,
    filesystem: TransparentProcessFilesystemPort,
  ): PreparedCommandRequest | null {
    if (!COMMAND_EXEC_METHODS.has(message.method ?? "")) {
      return { message, commandProcess: null };
    }
    let preparedMessage = message;
    const cwd = stringParam(message, "cwd");
    if (message.method === "command/exec" && cwd !== null) {
      const virtualCwd = this.resolveVirtualWorkingDirectory(cwd, filesystem);
      if (virtualCwd !== null) {
        filesystem.ensureWorkingDirectory(virtualCwd, state.user, state.viewId);
        preparedMessage = withParam(message, "cwd", virtualCwd);
      }
    }
    const clientProcessId = stringParam(preparedMessage, "processId");
    if (clientProcessId === null) return { message, commandProcess: null };
    let perConnection = state.commandProcessesByConnection.get(connection);
    if (perConnection === undefined) {
      perConnection = new Map();
      state.commandProcessesByConnection.set(connection, perConnection);
    }
    let commandProcess = perConnection.get(clientProcessId);
    if (message.method === "command/exec") {
      if (commandProcess !== undefined) {
        connection.socket.send({
          id: message.id,
          error: {
            code: -32602,
            message: `duplicate active command/exec process id: ${JSON.stringify(clientProcessId)}`,
          },
        });
        return null;
      }
      commandProcess = {
        connection,
        clientProcessId,
        backendProcessId: this.nextId("process"),
      };
      perConnection.set(clientProcessId, commandProcess);
      state.commandProcesses.set(commandProcess.backendProcessId, commandProcess);
    } else if (commandProcess === undefined) {
      connection.socket.send({
        id: message.id,
        error: {
          code: -32602,
          message: `no active command/exec for process id ${JSON.stringify(clientProcessId)}`,
        },
      });
      return null;
    }
    return {
      message: withParam(preparedMessage, "processId", commandProcess.backendProcessId),
      commandProcess,
    };
  }

  releaseCommandProcess(
    state: TransparentProcessState,
    commandProcess: TransparentCommandProcess | null | undefined,
  ): void {
    if (commandProcess == null) return;
    state.commandProcesses.delete(commandProcess.backendProcessId);
    const perConnection = state.commandProcessesByConnection.get(commandProcess.connection);
    perConnection?.delete(commandProcess.clientProcessId);
    if (perConnection?.size === 0) state.commandProcessesByConnection.delete(commandProcess.connection);
  }

  prepareHostProcessRequest(
    state: TransparentProcessState,
    connection: AppServerConnection,
    message: JsonRpcRequest,
    filesystem: TransparentProcessFilesystemPort,
  ): PreparedHostProcessRequest | null {
    if (!HOST_PROCESS_METHODS.has(message.method ?? "")) {
      return { message, hostProcess: null };
    }
    let preparedMessage = message;
    let virtualCwd: string | null = null;
    let physicalCwd: string | null = null;
    let clientCwd: string | null = null;
    const cwd = stringParam(message, "cwd");
    if (message.method === "process/spawn" && cwd !== null) {
      clientCwd = cwd;
      virtualCwd = this.resolveVirtualWorkingDirectory(clientCwd, filesystem);
      if (virtualCwd !== null) {
        physicalCwd = filesystem.ensureWorkingDirectory(virtualCwd, state.user, state.viewId);
        preparedMessage = withParam(message, "cwd", virtualCwd);
      }
    }
    const clientProcessHandle = stringParam(preparedMessage, "processHandle");
    if (clientProcessHandle === null) return { message, hostProcess: null };
    let perConnection = state.hostProcessesByConnection.get(connection);
    if (perConnection === undefined) {
      perConnection = new Map();
      state.hostProcessesByConnection.set(connection, perConnection);
    }
    let hostProcess = perConnection.get(clientProcessHandle);
    if (message.method === "process/spawn") {
      if (hostProcess !== undefined) {
        connection.socket.send({
          id: message.id,
          error: {
            code: -32602,
            message: `duplicate active process handle: ${JSON.stringify(clientProcessHandle)}`,
          },
        });
        return null;
      }
      hostProcess = {
        connection,
        clientProcessHandle,
        backendProcessHandle: this.nextId("host-process"),
        clientCwd,
        virtualCwd,
        physicalCwd,
      };
      perConnection.set(clientProcessHandle, hostProcess);
      state.hostProcesses.set(hostProcess.backendProcessHandle, hostProcess);
    } else if (hostProcess === undefined) {
      connection.socket.send({
        id: message.id,
        error: {
          code: -32602,
          message: `no active process for handle ${JSON.stringify(clientProcessHandle)}`,
        },
      });
      return null;
    }
    if (preparedMessage.method === "process/writeStdin" && hostProcess.physicalCwd !== null) {
      preparedMessage = this.rewriteVirtualActionInput(preparedMessage, hostProcess);
    }
    return {
      message: withParam(preparedMessage, "processHandle", hostProcess.backendProcessHandle),
      hostProcess,
    };
  }

  private rewriteVirtualActionInput(
    message: JsonRpcRequest,
    hostProcess: TransparentHostProcess,
  ): JsonRpcRequest {
    const encoded = stringParam(message, "deltaBase64");
    const delta = encoded === null ? null : decodeUtf8Base64(encoded);
    if (delta === null || !/^\s*cd\s+/.test(delta) || !/\s&&\s/.test(delta)) return message;
    let rewritten = delta;
    for (const candidate of new Set([hostProcess.clientCwd, hostProcess.virtualCwd])) {
      if (candidate === null || candidate.length === 0) continue;
      rewritten = rewritten.split(candidate).join(hostProcess.physicalCwd ?? candidate);
    }
    if (rewritten === delta) return message;
    console.info(
      `[transparent-process] mapped terminal action cwd virtual=${hostProcess.virtualCwd} ` +
      `physical=${hostProcess.physicalCwd}`,
    );
    return withParam(message, "deltaBase64", encodeUtf8Base64(rewritten));
  }

  releaseHostProcess(
    state: TransparentProcessState,
    hostProcess: TransparentHostProcess | null | undefined,
  ): void {
    if (hostProcess == null) return;
    state.hostProcesses.delete(hostProcess.backendProcessHandle);
    const perConnection = state.hostProcessesByConnection.get(hostProcess.connection);
    perConnection?.delete(hostProcess.clientProcessHandle);
    if (perConnection?.size === 0) state.hostProcessesByConnection.delete(hostProcess.connection);
  }

  routeCommandOutput(
    state: TransparentProcessState,
    message: JsonRpcResponse,
    project: (message: JsonRpcResponse) => JsonRpcResponse,
  ): RoutedProcessNotification {
    if (message.method !== "command/exec/outputDelta") return { handled: false };
    const processId = stringParam(message, "processId");
    const commandProcess = processId === null ? undefined : state.commandProcesses.get(processId);
    if (commandProcess === undefined || !state.connections.has(commandProcess.connection)) {
      return { handled: true };
    }
    return {
      handled: true,
      connection: commandProcess.connection,
      message: project({
        ...message,
        params: { ...rpcParams(message), processId: commandProcess.clientProcessId },
      }),
    };
  }

  routeHostProcessNotification(
    state: TransparentProcessState,
    message: JsonRpcResponse,
    project: (message: JsonRpcResponse) => JsonRpcResponse,
  ): RoutedProcessNotification {
    if (message.method !== "process/outputDelta" && message.method !== "process/exited") {
      return { handled: false };
    }
    const processHandle = stringParam(message, "processHandle");
    const hostProcess = processHandle === null ? undefined : state.hostProcesses.get(processHandle);
    if (hostProcess === undefined) return { handled: true };
    const routed: RoutedProcessNotification = state.connections.has(hostProcess.connection)
      ? {
        handled: true,
        connection: hostProcess.connection,
        message: project({
          ...message,
          params: { ...rpcParams(message), processHandle: hostProcess.clientProcessHandle },
        }),
      }
      : { handled: true };
    if (message.method === "process/exited") this.releaseHostProcess(state, hostProcess);
    return routed;
  }

  closeConnectionProcesses(
    state: TransparentProcessState,
    connection: AppServerConnection,
    filesystem: TransparentProcessFilesystemPort,
  ): void {
    const commands = [...(state.commandProcessesByConnection.get(connection)?.values() ?? [])];
    for (const commandProcess of commands) {
      this.releaseCommandProcess(state, commandProcess);
      if (state.phase !== "ready") continue;
      const id = this.nextId("terminate");
      state.internalControlRequests.set(id, { callback: () => undefined });
      filesystem.send(state.processId, {
        id,
        method: "command/exec/terminate",
        params: { processId: commandProcess.backendProcessId },
      });
    }
    const hostProcesses = [...(state.hostProcessesByConnection.get(connection)?.values() ?? [])];
    for (const hostProcess of hostProcesses) {
      this.releaseHostProcess(state, hostProcess);
      if (state.phase !== "ready") continue;
      const id = this.nextId("process-kill");
      state.internalControlRequests.set(id, { callback: () => undefined });
      filesystem.send(state.processId, {
        id,
        method: "process/kill",
        params: { processHandle: hostProcess.backendProcessHandle },
      });
    }
  }
}
