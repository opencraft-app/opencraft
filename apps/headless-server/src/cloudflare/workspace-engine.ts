// The workspace container's Engine Host as the workspace-host module drives it
// (`attachIndependentEngine`, `createExecutionRecovery`), reached through the
// container endpoint adapters (workspace-link.ts) instead of a Node socket.
// Same checks and routes as the Node attachment (`attachEngineHost`,
// server-deployment/engine-host-client.mjs) and the Node history reader
// (`createWebSocketExecutionTurnInspector`): the descriptor comes from the
// agent's authenticated `control` endpoint, the Host's health must match it,
// execution identity is only what the owner reports, attributed to the agent
// incarnation bound around it (`WorkspaceRuntime.fenced`), and a failed read
// stays unknown. No execution, storage or credential lives here.
import {
  SandboxFault,
  formatWorkspaceEndpointUri,
  parseWorkspaceEndpointUri,
  type WorkspaceEndpointAddress,
  type WorkspaceRuntime,
} from "@opencraft/sandbox";
import { createNativeExecutionTurnInspector } from "@opencraft/opencraft-daemon/native-execution-turn-inspector";
import { endpointHttpRequest, endpointJsonRpcRead, type EndpointDial } from "./workspace-link.js";

type Runtime = Pick<WorkspaceRuntime, "connect" | "describe" | "fenced" | "workspaceId">;

export interface WorkspaceEngineOptions {
  readonly runtime: Runtime;
  readonly endpoint: WorkspaceEndpointAddress;
  readonly machineId: string;
  readonly engines: readonly string[];
  readonly defaultEngine: string;
  /** False while the object opens: a use that would start the environment fails instead. */
  available(): boolean;
}

/** An Engine Host input receipt, as `/host-inputs` answers it. */
export interface WorkspaceEngineReceipt {
  readonly state: "delivered" | "discarded" | "unknown";
  readonly turnId: string | null;
}

export interface WorkspaceEngine {
  /** The engine's address for whoever reads its native history: its workspace endpoint URI. */
  readonly websocketUrl: string;
  resolveWebsocketUrl(): Promise<string>;
  readonly inputs: {
    receipt(threadId: string, inputId: string): Promise<WorkspaceEngineReceipt | null>;
    submit(
      threadId: string,
      inputId: string,
      text: string,
      canAdmit: () => Promise<boolean>,
    ): Promise<WorkspaceEngineReceipt | null>;
  };
  getExecutionIdentity(threadId: string): Promise<{
    pid: number | null;
    incarnation: string | null;
    turn?: { id: string; status: string; inputId: string | null } | null;
  }>;
  getIdentity(): Promise<{ pid: number }>;
  close(): Promise<void>;
}

const unavailable = (message: string) => new SandboxFault("SANDBOX_UNAVAILABLE", message);
/** `/execution-origin` as the Host answers it, before validation. */
interface ExecutionOrigin {
  readonly threadId?: unknown;
  readonly pid: number | null;
  readonly incarnation?: string | null;
  readonly turn?: { readonly id: string; readonly status: string; readonly inputId: string | null } | null;
}
const sorted = (value: readonly unknown[]) => [...value].map(String).sort().join();

/** The Host's private websocket in the container (`ws+unix:///abs.sock:/rpc?token=…`); its request path. */
export function engineRpcPath(raw: unknown): string {
  if (typeof raw !== "string") throw unavailable("Invalid engine websocket");
  const url = new URL(raw);
  const at = url.pathname.lastIndexOf(":");
  if (
    url.protocol !== "ws+unix:" ||
    url.hostname !== "" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.searchParams.get("token") ||
    at <= 0 ||
    !url.pathname.startsWith("/") ||
    url.pathname.slice(at + 1) !== "/rpc"
  )
    throw unavailable("Invalid engine websocket");
  return `/rpc${url.search}`;
}

function dialer(options: Pick<WorkspaceEngineOptions, "runtime" | "endpoint" | "available">): EndpointDial {
  return (onData) => {
    if (!options.available()) return Promise.reject(unavailable("Workspace is opening"));
    return options.runtime.connect(options.endpoint, onData);
  };
}

/** Attaches to the Engine Host behind `endpoint`. Nothing is contacted until first use. */
export function attachWorkspaceEngine(options: WorkspaceEngineOptions): WorkspaceEngine {
  const { runtime, endpoint, machineId, engines, defaultEngine } = options;
  const dial = dialer(options);
  const address = formatWorkspaceEndpointUri(endpoint);
  const read = async () => {
    if (!options.available()) throw unavailable("Workspace is opening");
    const d = (await runtime.describe(endpoint)) as Record<string, unknown>;
    engineRpcPath(d.websocketUrl);
    if (
      d.schemaVersion !== 1 ||
      d.controlUrl !== undefined ||
      d.machineId !== machineId ||
      !Number.isSafeInteger(d.pid) ||
      (d.pid as number) < 1 ||
      typeof d.token !== "string" ||
      !d.token ||
      !Array.isArray(d.engines) ||
      sorted(d.engines) !== sorted(engines) ||
      d.defaultEngine !== defaultEngine
    )
      throw unavailable("Engine Host descriptor is incompatible with this workspace");
    const response = await endpointHttpRequest(dial, "/health", { headers: { authorization: `Bearer ${d.token}` } });
    const health = response.json() as Record<string, unknown>;
    if (
      !response.ok ||
      health.ok !== true ||
      health.protocolVersion !== 1 ||
      health.pid !== d.pid ||
      health.machineId !== machineId ||
      health.defaultEngine !== defaultEngine ||
      !Array.isArray(health.engines) ||
      sorted(health.engines) !== sorted(engines)
    )
      throw unavailable("Independent execution Host is unavailable");
    return { token: d.token, pid: d.pid as number };
  };
  const input = async (
    action: "receipt" | "submit",
    threadId: string,
    inputId: string,
    text?: string,
  ): Promise<WorkspaceEngineReceipt | null> => {
    const { token } = await read();
    const response = await endpointHttpRequest(dial, "/host-inputs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, threadId, inputId, ...(text === undefined ? {} : { text }) }),
      timeoutMs: 35_000,
    });
    if (!response.ok) throw new Error("Execution Host input outcome unknown");
    const { receipt } = response.json() as { receipt?: WorkspaceEngineReceipt | null };
    if (
      receipt !== null &&
      (!receipt ||
        !["delivered", "discarded", "unknown"].includes(receipt.state) ||
        (receipt.turnId !== null && typeof receipt.turnId !== "string"))
    )
      throw new Error("Invalid execution Host input receipt");
    return receipt;
  };
  return {
    websocketUrl: address,
    resolveWebsocketUrl: async () => address,
    inputs: {
      receipt: (threadId, inputId) => input("receipt", threadId, inputId),
      submit: async (threadId, inputId, text, canAdmit) =>
        (await canAdmit()) ? input("submit", threadId, inputId, text) : null,
    },
    async getExecutionIdentity(threadId) {
      if (typeof threadId !== "string" || !threadId || threadId.length > 512)
        throw new Error("Execution Thread required");
      if (!options.available()) throw unavailable("Workspace is opening");
      const result = (await runtime.fenced(endpoint, async () => {
        const { token } = await read();
        const response = await endpointHttpRequest(dial, `/execution-origin?threadId=${encodeURIComponent(threadId)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error("Execution process unavailable");
        return response.json();
      })) as ExecutionOrigin;
      if (
        result.threadId !== threadId ||
        (result.pid !== null && (!Number.isSafeInteger(result.pid) || result.pid < 1)) ||
        (result.pid === null
          ? result.incarnation !== undefined && result.incarnation !== null
          : typeof result.incarnation !== "string" || !result.incarnation || result.incarnation.length > 512)
      )
        throw new Error("Execution process unavailable");
      if (
        result.turn !== undefined &&
        result.turn !== null &&
        (typeof result.turn.id !== "string" ||
          typeof result.turn.status !== "string" ||
          (result.turn.inputId !== null && typeof result.turn.inputId !== "string"))
      )
        throw new Error("Invalid execution observation");
      return {
        pid: result.pid,
        incarnation: result.pid === null ? null : (result.incarnation as string),
        ...(result.turn === undefined ? {} : { turn: result.turn }),
      };
    },
    async getIdentity() {
      return { pid: (await read()).pid };
    },
    async close() {},
  };
}

/**
 * The execution history reader for the module's `createExecutionRecovery`:
 * `resolveTarget` names the engine's workspace endpoint; each read is one
 * fresh endpoint WebSocket to the Host's App Server (at most four at once).
 */
export function workspaceExecutionRecovery(options: Pick<WorkspaceEngineOptions, "runtime" | "available">) {
  return async (resolveTarget: () => Promise<string | undefined>) => {
    let closed = false,
      active = 0;
    const request = async (method: string, params: Record<string, unknown>, signal: AbortSignal) => {
      const endpoint = parseWorkspaceEndpointUri(await resolveTarget());
      if (endpoint.workspaceId !== options.runtime.workspaceId || closed || signal.aborted || active >= 4)
        throw unavailable("Local execution reader unavailable");
      if (!options.available()) throw unavailable("Workspace is opening");
      const path = engineRpcPath(((await options.runtime.describe(endpoint)) as Record<string, unknown>).websocketUrl);
      active++;
      try {
        return await endpointJsonRpcRead(dialer({ ...options, endpoint }), path, method, params, { signal });
      } finally {
        active--;
      }
    };
    return {
      inspect: createNativeExecutionTurnInspector(request),
      // Exact original inputs, without Resume or a tool callback lane.
      readThread: (threadId: string) =>
        request("thread/read", { threadId, includeTurns: true }, AbortSignal.timeout(1500)) as Promise<{
          thread?: { turns?: unknown[] };
        } | null>,
      close() {
        closed = true;
      },
    };
  };
}
