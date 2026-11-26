import {
  parseWorkspaceEndpointUri,
  SandboxFault,
  type SandboxReceipt,
  type WorkspacePlacementRecord,
  type WorkspaceRuntime,
} from "@opencraft/sandbox";
import { BridgeGatewaySession, BridgeOutboxReadError, pullBridgeInbox, type BridgeHistorySelection } from "@opencraft/agent-bridge-host/gateway-session";
import { createWorkspaceBridgeInboxStore } from "@opencraft/agent-bridge-host/inbox-store";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import { CodexProviderBridgeSession, observeCodexBridgeHistory } from "@opencraft/opencraft-daemon/codex-provider-bridge-session";
import type { SqlDatabase } from "@opencraft/sql";
import type { CodexHistoryRead } from "./codex-thread-read.js";
import { EndpointHttpInterrupted, endpointHttpRequest, type EndpointWebSocket } from "./workspace-link.js";

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
        {
          fenced: true, fragmentOversized: true,
          isReadInterrupted: error => error instanceof EndpointHttpInterrupted,
        },
      );
    })().finally(() => {
      if (pulling?.result === result) pulling = undefined;
    });
    pulling = { receipt: key, result };
    return result;
  };
  return {
    request,
    async canSleep(receipt: SandboxReceipt): Promise<boolean> {
      try {
        const response = await request("/maintenance", undefined, receipt);
        if (!response.ok) {
          await response.body?.cancel();
          return false;
        }
        const state = (await response.json()) as { inFlight?: unknown } | null;
        return state?.inFlight === 0;
      } catch {
        return false;
      }
    },
    async pull() {
      const { receipt, restoredFrom } = await binding();
      return pull(receipt, restoredFrom);
    },
    async attach(expected?: SandboxReceipt, { synchronizeInbox = true } = {}) {
      const { receipt, restoredFrom } = await binding(expected);
      const key = placementKey(receipt);
      const ensureInboxPlacement = async () => {
        if (store.placement() !== key) await pull(receipt, restoredFrom);
      };
      if (synchronizeInbox) await ensureInboxPlacement();
      const assertPlacement = () => {
        if (store.placement() !== key) throw new Error("Workspace Bridge inbox placement changed");
      };
      return {
        receipt,
        ensureInboxPlacement,
        withCurrentPlacement: <T>(operation: () => Promise<T>) => runtime.fenced(endpoint, operation, receipt),
        request: (path: string, body?: unknown) => request(path, body, receipt),
        async cursor() { assertPlacement(); return store.cursor(); },
        async read(cursor: number) { assertPlacement(); return store.read(cursor); },
        async readIdentities(route: string, after: number, through: number, selection?: BridgeHistorySelection) {
          assertPlacement();
          return store.readIdentities(route, after, through, selection);
        },
        async readAcknowledgedIdentities(route: string, after: number, through: number, outboxId: string, selection?: BridgeHistorySelection) {
          return store.readAcknowledgedIdentities(route, after, through, outboxId, selection);
        },
        async readPendingInteractions(route: string, after: number, through: number, ids: readonly string[]) {
          assertPlacement();
          return store.readPendingInteractions(route, after, through, ids);
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
  { passiveHistory = false } = {},
) {
  return new BridgeGatewaySession(
    {
      serverId,
      request: attachment.request,
      inbox: { cursor: attachment.cursor, read: attachment.read, readIdentities: attachment.readIdentities,
        ...(passiveHistory ? { readAcknowledgedIdentities: attachment.readAcknowledgedIdentities } : {}),
        readPendingInteractions: attachment.readPendingInteractions,
        pull: attachment.pull, close: async () => {} },
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
  { receipt, passiveNative }: { receipt?: SandboxReceipt; passiveNative: boolean },
): Promise<unknown> {
  const metadataOnly = method === "thread/read" && params.includeTurns !== true;
  const attachment = await transport.attach(receipt, { synchronizeInbox: false });
  const gateway = workspaceBridgeGateway(serverId, attachment, () => {}, { passiveHistory: true });
  try {
    return await attachment.withCurrentPlacement(async () => {
      const historyIdentityPages = await gateway.loadRouteSnapshot();
      const { threadId, turnId, openArchivedHistory: _intent, ...query } = params;
      const nativeId = gateway.nativeThread(threadId);
      if (!nativeId && (gateway.owns(threadId) || threadId.startsWith("bridge:codex:") || gateway.publicThread(threadId)))
        throw new SandboxFault("SANDBOX_UNAVAILABLE", "Workspace Codex Bridge history identity unavailable");
      if (nativeId && !metadataOnly && !historyIdentityPages) {
        // A producer predating identity pages still uses the compatible inbox replay path.
        await attachment.ensureInboxPlacement();
        await gateway.open({ live: false });
      }
      if (nativeId && !passiveNative) return observeCodexBridgeHistory(gateway, threadId, method, params);
      const readNative = (nativeTurnId?: string) => read(
        method,
        {
          ...query,
          threadId: nativeId ?? threadId,
          ...(nativeTurnId === undefined ? {} : { turnId: nativeTurnId }),
        },
        attachment.receipt,
      );
      const requestedTurn = typeof turnId === "string" ? turnId : undefined;
      return nativeId
        ? gateway.readProjectedHistory(threadId, readNative, { turnId: requestedTurn, metadataOnly })
        : readNative(requestedTurn);
    });
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
    { newThreads: true, manualPull: true, retryInitialEventPull: observe },
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
  const poll = (delay = 125) => {
    if (finished) return;
    timer = setTimeout(() => {
      void adapter.pull().then(
        () => poll(),
        error => {
          if (error instanceof EndpointHttpInterrupted || (error instanceof BridgeOutboxReadError && error.retryable)) {
            poll(Math.min(delay * 2, 2000));
          } else {
            void close().catch(() => {});
          }
        },
      );
    }, delay);
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
