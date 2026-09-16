import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  AppServerParams,
  JsonRpcRequest,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type {
  TransparentControlRoutingPort,
} from "../types/transparent-control-routing.ts";
import type { TransparentInternalControlRequest } from "../types/transparent-process.ts";
import { rpcParams } from "../types/transparent-process.ts";
import { isBackendLocalArtifactRead } from "./backend-local-process.ts";
import {
  COMMAND_EXEC_METHODS,
  HOST_PROCESS_METHODS,
  USER_BACKEND_GLOBAL_CONTROL_METHODS,
} from "./transparent-thread-routing.ts";

const INTERNAL_PREFIX = "hypernode:transparent:";
const IDENTITY_REQUIRED = {
  code: -32052,
  message: "Codex account binding requires an SSH user identity",
} as const;
const SHARED_CODEX_LOGOUT_FORBIDDEN = {
  code: -32086,
  message: "共享 Codex 槽位不能从使用者会话退出；请切换到自己的账户",
} as const;

type Dependencies =
  | "credential"
  | "runtimeWorkspace"
  | "transparentBackendLifecycle"
  | "transparentBackendRegistry"
  | "transparentBackendRpc"
  | "transparentProcessBridge"
  | "transparentRuntimeAccess"
  | "transparentRuntimeLocator";

/**
 * Routes AppServer control-plane and host-process requests to live runtimes.
 * It owns transient correlation ids only; Thread history and Runtime lifecycle
 * remain authoritative in their dedicated services.
 */
export class TransparentControlRoutingService extends Service
  implements TransparentControlRoutingPort {
  static inject = [
    "credential",
    "runtimeWorkspace",
    "transparentBackendLifecycle",
    "transparentBackendRegistry",
    "transparentBackendRpc",
    "transparentProcessBridge",
    "transparentRuntimeAccess",
    "transparentRuntimeLocator",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private sequence = 0;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentControlRouting");
  }

  requestUserBackend(
    connection: AppServerConnection,
    method: string,
    params: AppServerParams,
    callback: TransparentInternalControlRequest["callback"],
  ): void {
    const ownerUserId = connection.identity?.id;
    if (!ownerUserId) {
      callback(IDENTITY_REQUIRED);
      return;
    }
    if (method === "account/logout" && this.usesSharedCodex(ownerUserId)) {
      callback(SHARED_CODEX_LOGOUT_FORBIDDEN);
      return;
    }
    const state = this.ensureCodexControlBackend(connection, ownerUserId);
    const request: TransparentInternalControlRequest = { method, params, callback };
    if (state.phase === "ready") this.forwardInternalControlNow(state, request);
    else state.pendingInternalControl.push(request);
  }

  ensureCodexControlBackend(
    connection: AppServerConnection,
    ownerUserId: string,
  ): TransparentBackendState {
    // Account/model/collaboration discovery belongs to the user's host-local
    // Codex control plane. It must never start or depend on a Workspace runtime.
    const filesystem = this.ctx.transparentRuntimeAccess.localFilesystem;
    const baseKey = this.ctx.transparentRuntimeAccess.backendKey(
      ownerUserId,
      filesystem,
      "main",
    );
    return this.ensureBackend(
      connection, ownerUserId, filesystem, "main", "/localhost", {
        backendKey: `${baseKey}\0control:codex`,
        accountIdentity: this.ctx.credential.resolveCodexUser(ownerUserId)?.accountIdentity ?? null,
        providerId: null,
      },
    );
  }

  resetCodexControlBackend(ownerUserId: string): boolean {
    const filesystem = this.ctx.transparentRuntimeAccess.localFilesystem;
    const baseKey = this.ctx.transparentRuntimeAccess.backendKey(
      ownerUserId,
      filesystem,
      "main",
    );
    const state = this.ctx.transparentBackendRegistry.backends.get(
      `${baseKey}\0control:codex`,
    );
    return state
      ? this.ctx.transparentBackendLifecycle.closeProcess(state, null)
      : false;
  }

  forwardInternalControlNow(
    state: TransparentBackendState,
    request: TransparentInternalControlRequest,
  ): void {
    if (!request.method) {
      request.callback({ code: -32600, message: "internal control request has no method" });
      return;
    }
    const backendId = this.nextId("internal-control");
    state.internalControlRequests.set(backendId, request);
    const message: JsonRpcRequest = request.params === undefined
      ? { id: backendId, method: request.method }
      : { id: backendId, method: request.method, params: request.params };
    this.ctx.transparentRuntimeAccess.filesystem(state).send(state.processId, message);
  }

  queueControl(
    connection: AppServerConnection,
    message: JsonRpcRequest,
  ): void {
    const ownerUserId = connection.identity?.id;
    if (message.method === "account/logout" && ownerUserId && this.usesSharedCodex(ownerUserId)) {
      connection.socket.send({ id: message.id, error: SHARED_CODEX_LOGOUT_FORBIDDEN });
      return;
    }
    const state = this.stateForControl(connection, message);
    if (state === null) {
      connection.socket.send({ id: message.id, error: IDENTITY_REQUIRED });
      return;
    }
    if (state.phase === "ready") this.forwardControlNow(state, connection, message);
    else state.pendingControl.push({ connection, message });
  }

  stateForControl(
    connection: AppServerConnection,
    message: JsonRpcRequest,
  ): TransparentBackendState | null {
    const states = this.ctx.transparentBackendRegistry.connections.get(connection) ?? new Set();
    const method = message.method ?? "";
    const params = rpcParams(message);
    if (HOST_PROCESS_METHODS.has(method) && method !== "process/spawn") {
      const handle = params["processHandle"];
      for (const state of states) {
        if (state.hostProcessesByConnection.get(connection)?.has(String(handle))) return state;
      }
    }
    if (COMMAND_EXEC_METHODS.has(method) && method !== "command/exec") {
      const processId = params["processId"];
      for (const state of states) {
        if (state.commandProcessesByConnection.get(connection)?.has(String(processId))) return state;
      }
    }

    if (connection.activeThreadId && isBackendLocalArtifactRead(message)) {
      const activeState = this.ctx.transparentRuntimeLocator.stateForOuter(
        connection.activeThreadId,
        this.ctx.transparentRuntimeAccess.localFilesystem,
      );
      if (activeState && activeState.phase !== "failed") {
        this.ctx.transparentBackendRegistry.attach(activeState, connection);
        return activeState;
      }
    }

    const ownerUserId = connection.identity?.id;
    if (!ownerUserId) return null;
    if (USER_BACKEND_GLOBAL_CONTROL_METHODS.has(method)) {
      return this.ensureCodexControlBackend(connection, ownerUserId);
    }

    const cwdValue = params["cwd"];
    const cwd = typeof cwdValue === "string" ? cwdValue : null;
    const filesystem = this.ctx.transparentRuntimeAccess.filesystemForCwd(cwd) ??
      this.ctx.transparentRuntimeAccess.defaultFilesystem();
    let viewId = "main";
    if (this.ctx.runtimeWorkspace.isWorkspaceFilesystem(filesystem)) {
      const segment = cwd?.match(/^\/workspace\/@(main|fork-[^/]+)(?:\/|$)/)?.[1] ?? null;
      if (segment === "main") viewId = "main";
      else if (segment?.startsWith("fork-")) viewId = segment.slice("fork-".length);
      else if (connection.activeThreadId) {
        viewId = this.ctx.runtimeWorkspace.viewIdForThread(connection.activeThreadId);
      }
    }
    return this.ensureBackend(connection, ownerUserId, filesystem, viewId, cwd);
  }

  forwardControlNow(
    state: TransparentBackendState,
    connection: AppServerConnection,
    message: JsonRpcRequest,
  ): void {
    const filesystem = this.ctx.transparentRuntimeAccess.filesystem(state);
    const preparedCommand = this.ctx.transparentProcessBridge.prepareCommandRequest(
      state,
      connection,
      message,
      filesystem,
    );
    if (!preparedCommand) return;
    const prepared = this.ctx.transparentProcessBridge.prepareHostProcessRequest(
      state,
      connection,
      preparedCommand.message,
      filesystem,
    );
    if (!prepared) return;
    const backendId = this.nextId("control");
    this.ctx.transparentBackendRpc.trackForwarded(state, backendId, {
      connection,
      clientId: message.id,
      outerThreadId: null,
      method: message.method,
      commandProcess: preparedCommand.commandProcess,
      hostProcess: prepared.hostProcess,
    });
    if (isBackendLocalArtifactRead(message)) {
      const command = rpcParams(message)["command"];
      const path = Array.isArray(command) ? command[1] : undefined;
      console.info(
        `[transparent-control] artifact read forward path=${String(path ?? "")} ` +
        `backend=${state.backendKey} process=${state.processId} ` +
        `clientHandle=${String(rpcParams(message)["processHandle"] ?? "none")} ` +
        `backendHandle=${prepared.hostProcess?.backendProcessHandle ?? "none"}`,
      );
    }
    filesystem.send(state.processId, {
      ...this.ctx.transparentRuntimeAccess.toInner(prepared.message, state),
      id: backendId,
    });
  }

  private ensureBackend(
    connection: AppServerConnection,
    ownerUserId: string,
    filesystem: ReturnType<HypernodeServices["transparentRuntimeAccess"]["defaultFilesystem"]>,
    viewId: string,
    initialCwd: string | null,
    options = {},
  ): TransparentBackendState {
    return this.ctx.transparentBackendLifecycle.ensure({
      connection,
      ownerUserId,
      filesystem,
      viewId,
      initialCwd,
      defaultBackendKey: this.ctx.transparentRuntimeAccess.backendKey(
        ownerUserId,
        filesystem,
        viewId,
      ),
      workspaceRealm: this.ctx.transparentRuntimeAccess.isWorkspaceFilesystem(filesystem),
      options,
    });
  }

  private usesSharedCodex(ownerUserId: string): boolean {
    const credential = this.ctx.credential.resolveCodexUser(ownerUserId);
    return credential?.username
      ? hostIdentity.readActiveCodexShare(credential.username).length > 0
      : false;
  }

  private nextId(kind: string): string {
    this.sequence += 1;
    return `${INTERNAL_PREFIX}${kind}:${this.sequence}`;
  }
}
