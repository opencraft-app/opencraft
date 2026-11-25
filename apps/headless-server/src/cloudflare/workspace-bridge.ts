import {
  parseWorkspaceEndpointUri,
  SandboxFault,
  type SandboxReceipt,
  type WorkspacePlacementRecord,
  type WorkspaceRuntime,
} from "@opencraft/sandbox";
import { BridgeGatewaySession, pullBridgeInbox } from "@opencraft/agent-bridge-host/gateway-session";
import { createWorkspaceBridgeInboxStore } from "@opencraft/agent-bridge-host/inbox-store";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import { CodexProviderBridgeSession } from "@opencraft/opencraft-daemon/codex-provider-bridge-session";
import type { SqlDatabase } from "@opencraft/sql";
import type { CodexHistoryRead } from "./codex-thread-read.js";
import { endpointHttpRequest, type EndpointWebSocket } from "./workspace-link.js";

const bridgeEndpoint = (workspaceId: string) =>
  parseWorkspaceEndpointUri(`workspace://${workspaceId}/endpoints/codex-bridge`);
const placementKey = (receipt: SandboxReceipt) => JSON.stringify([receipt.backend, receipt.instanceId]);

export function workspaceBridgeTransport(runtime: Pick<WorkspaceRuntime, "workspaceId" | "fenced">) {
  const endpoint = bridgeEndpoint(runtime.workspaceId);
  return (path: string, body?: unknown, receipt?: SandboxReceipt): Promise<Response> =>
    runtime.fenced(
      endpoint,
      async (binding) => {
        const descriptor = await binding.describe();
        const token = descriptor.token;
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,1024}$/u.test(token))
          throw new SandboxFault("SANDBOX_UNAVAILABLE", "Workspace Codex Bridge credential unavailable");
        const response = await endpointHttpRequest(binding.connect, path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          timeoutMs: 10_000,
        });
        const contentType = response.headers.get("content-type");
        return new Response(response.body.byteLength ? response.text() : null, {
          status: response.status,
          ...(contentType ? { headers: { "content-type": contentType } } : {}),
        });
      },
      receipt,
    );
}

export async function checkWorkspaceBridge(request: ReturnType<typeof workspaceBridgeTransport>): Promise<void> {
  const response = await request("/health");
  const value = (await response.json().catch(() => null)) as { incarnation?: unknown; generations?: unknown } | null;
  if (!response.ok || typeof value?.incarnation !== "string" || !value.incarnation || !Array.isArray(value.generations))
    throw new SandboxFault("SANDBOX_UNAVAILABLE", "Workspace Codex Bridge did not confirm readiness");
}

export function createWorkspaceBridge(
  runtime: Parameters<typeof workspaceBridgeTransport>[0],
  database: SqlDatabase,
  sync: () => Promise<void>,
  previousReceipt?: SandboxReceipt,
) {
  const request = workspaceBridgeTransport(runtime);
  const store = createWorkspaceBridgeInboxStore(database);
  store.adoptPlacement(previousReceipt && placementKey(previousReceipt));
  let pulling: { receipt: string; result: ReturnType<typeof pullBridgeInbox> } | undefined;
  const endpoint = bridgeEndpoint(runtime.workspaceId);
  const binding = (expected?: SandboxReceipt) =>
    runtime.fenced(
      endpoint,
      async ({ placement }) => {
        const { receipt } = placement;
        if (!receipt) throw new SandboxFault("SANDBOX_UNAVAILABLE", "Workspace Bridge has no placement receipt");
        return { receipt, restoredFrom: placement.restoredFrom };
      },
      expected,
    );
  const pull = (receipt: SandboxReceipt, restoredFrom: WorkspacePlacementRecord["restoredFrom"]) => {
    const key = placementKey(receipt);
    if (pulling?.receipt === key) return pulling.result;
    const previous = pulling?.result;
    const scoped = (path: string, body?: unknown) => request(path, body, receipt);
    const result = (async () => {
      await previous?.catch(() => {});
      const last = store.placement();
      let from = store.cursor();
      if (last && last !== key) {
        const snapshot = await scoped("/snapshot");
        if (!snapshot.ok) {
          await snapshot.body?.cancel();
          throw new Error("Replacement Bridge snapshot unavailable");
        }
        const value = (await snapshot.json()) as { ack?: unknown } | null;
        if (typeof value?.ack !== "number" || !Number.isSafeInteger(value.ack) || value.ack < 0)
          throw new Error("Invalid replacement Bridge cursor");
        from = value.ack;
      }
      return pullBridgeInbox(
        scoped,
        {
          cursor: () => from,
          async apply(batch, fence) {
            if (!fence) throw new Error("Workspace Bridge fence required");
            const apply = () => store.apply(key, restoredFrom, from, batch, fence);
            const committed = last === key ? apply() : await runtime.fenced(endpoint, async () => apply(), receipt);
            if (last !== key || committed.cursor > fence.acknowledged) await sync();
            return committed;
          },
        },
        true,
      );
    })().finally(() => {
      if (pulling?.result === result) pulling = undefined;
    });
    pulling = { receipt: key, result };
    return result;
  };
  return {
    request,
    async pull() {
      const { receipt, restoredFrom } = await binding();
      return pull(receipt, restoredFrom);
    },
    async attach(expected?: SandboxReceipt) {
      const { receipt, restoredFrom } = await binding(expected);
      const key = placementKey(receipt);
      if (store.placement() !== key) await pull(receipt, restoredFrom);
      return {
        receipt,
        request: (path: string, body?: unknown) => request(path, body, receipt),
        read(cursor: number) {
          if (store.placement() !== key) throw new Error("Workspace Bridge inbox placement changed");
          return store.read(cursor);
        },
        pull: () => pull(receipt, restoredFrom),
      };
    },
  };
}

export type WorkspaceBridge = ReturnType<typeof createWorkspaceBridge>;
type WorkspaceBridgeAttachment = Awaited<ReturnType<WorkspaceBridge["attach"]>>;

function workspaceBridgeGateway(
  serverId: string,
  attachment: WorkspaceBridgeAttachment,
  publish: (threadId: string, value: unknown) => void,
) {
  return new BridgeGatewaySession(
    {
      serverId,
      request: attachment.request,
      inbox: { read: async (cursor) => attachment.read(cursor), pull: attachment.pull, close: async () => {} },
    },
    publish,
  );
}

/** Resolve Bridge identities at the current sandbox receipt without resuming an execution session. */
export async function readWorkspaceBridgeHistory(
  { transport, serverId }: { transport: WorkspaceBridge; serverId: string },
  method: CodexHistoryRead["method"],
  params: Record<string, unknown> & { threadId: string },
  read: (
    method: CodexHistoryRead["method"],
    params: Record<string, unknown>,
    receipt: SandboxReceipt,
  ) => Promise<unknown>,
  receipt?: SandboxReceipt,
): Promise<unknown> {
  const attachment = await transport.attach(receipt);
  const gateway = workspaceBridgeGateway(serverId, attachment, () => {});
  try {
    await gateway.open();
    const { threadId, turnId, ...query } = params;
    const nativeId = gateway.nativeThread(threadId);
    if (!nativeId && (gateway.owns(threadId) || threadId.startsWith("bridge:codex:") || gateway.publicThread(threadId)))
      throw new SandboxFault("SANDBOX_UNAVAILABLE", "Workspace Codex Bridge history identity unavailable");
    const result = await read(
      method,
      {
        ...query,
        threadId: nativeId ?? threadId,
        ...(typeof turnId === "string" ? { turnId: nativeId ? gateway.nativeTurn(threadId, turnId) : turnId } : {}),
      },
      attachment.receipt,
    );
    return nativeId ? gateway.history(threadId, result) : result;
  } finally {
    await gateway.close();
  }
}

/** Present the shared AppServer adapter as the same lane the WorkspaceHost already owns. */
export async function openWorkspaceBridgeLane<T extends EndpointWebSocket>(
  bridge: WorkspaceBridge,
  serverId: string,
  openNative: (onFrame: (frame: string) => void, receipt: SandboxReceipt) => Promise<T>,
  onFrame: (frame: string) => void,
  observe: boolean,
  expected?: SandboxReceipt,
): Promise<T> {
  const logicalClient = "workspace-host";
  let receiveNative: ((frame: string) => void) | undefined;
  const attachment = await bridge.attach(expected);
  const native = await openNative((raw) => {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    receiveNative?.(JSON.stringify({ ...frame, [LOGICAL_CLIENT_FIELD]: logicalClient }));
  }, attachment.receipt);
  const legacy: DuplexTransport = {
    status: { state: "open" },
    async connect() {},
    close: () => native.close(),
    subscribeStatus: () => () => {},
    subscribeMessage(listener) {
      receiveNative = listener;
      return () => {
        if (receiveNative === listener) receiveNative = undefined;
      };
    },
    send(raw) {
      const { [LOGICAL_CLIENT_FIELD]: _, ...frame } = JSON.parse(raw) as Record<string, unknown>;
      return native.send(JSON.stringify(frame));
    },
  };
  const adapter = new CodexProviderBridgeSession(
    legacy,
    (publish) => workspaceBridgeGateway(serverId, attachment, publish),
    { newThreads: true, manualPull: true },
  );
  const stop = adapter.subscribeMessage(onFrame);
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished: Promise<void> | undefined;
  const close = () =>
    (finished ??= (async () => {
      clearTimeout(timer);
      stop();
      end();
      await adapter.close();
    })());
  await adapter.connect().catch(async (error) => {
    await close().catch(() => {});
    throw error;
  });
  void native.closed.then(() => close().catch(() => {}));
  const poll = () => {
    if (finished) return;
    timer = setTimeout(() => {
      void adapter.pull().then(poll, () => close().catch(() => {}));
    }, 125);
  };
  if (observe) poll();
  return {
    ...native,
    closed: ended,
    close,
    send(raw) {
      if (finished) return Promise.reject(new Error("Workspace Bridge lane closed"));
      return adapter.send(JSON.stringify({ ...JSON.parse(raw), [LOGICAL_CLIENT_FIELD]: logicalClient }));
    },
  };
}
