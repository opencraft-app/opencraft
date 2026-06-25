import {
  createTatPortFetch,
  type TatHttpVirtualFetch,
  type TatHttpVirtualFetchInit,
} from "@/lib/tat-http-virtual-client";
import { TatTransportError, normalizeTatTransportError } from "@/lib/tat-transport-error";
import { TencentTsshProxyClient } from "@/lib/tencent-tssh-proxy-client";
import type { BotTerminalSession } from "@/domain/types";
import type { BotRepository } from "@/repositories/types";
import {
  createFetchVelaEventStreamTransport,
  createVeladClient,
  type VelaEventStreamTransport,
  type VeladClient,
} from "velachat/packages/vela-chat-client/src";

import { LOCAL_VELAD_BASE_URL } from "./velad-endpoint";

export const VELAD_VM_PORT = 3857;

export type WorkbenchVeladTransportMode = "vm_tat" | "direct_http";

export interface ResolvedWorkbenchVeladTransport {
  baseUrl: string;
  client: VeladClient;
  close: () => void;
  eventStreamTransport?: VelaEventStreamTransport;
  mode: WorkbenchVeladTransportMode;
}

export interface CreateVmWorkbenchVeladTransportInput {
  botId: string;
  getTerminalSession: BotRepository["getTerminalSession"];
}

interface WorkbenchTatClients {
  apiTatFetch: TatHttpVirtualFetch;
  bootstrap: BotTerminalSession;
  proxyClient: TencentTsshProxyClient;
  streamTatFetch: TatHttpVirtualFetch;
}

function errorForLog(error: unknown) {
  return error instanceof Error
    ? {
        cause: error.cause,
        message: error.message,
        name: error.name,
        stack: error.stack,
      }
    : { message: String(error) };
}

function methodForRequest(init?: RequestInit | TatHttpVirtualFetchInit) {
  return (init?.method ?? (init && ("body" in init || "json" in init) ? "POST" : "GET")).toUpperCase();
}

function headersForRequest(init?: RequestInit | TatHttpVirtualFetchInit) {
  return new Headers(init?.headers);
}

function isReplaySafeRequest(
  label: "api" | "stream",
  init?: RequestInit | TatHttpVirtualFetchInit,
) {
  if (label === "stream") {
    return true;
  }
  const method = methodForRequest(init);
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }
  return Boolean(headersForRequest(init).get("Idempotency-Key"));
}

function asTatFetchInput(input: string | URL | Request): string | URL {
  if (input instanceof Request) {
    throw new TatTransportError(
      "fatal",
      "Workbench TAT transport does not support replaying Request object bodies",
      { phase: "request", retryable: false },
    );
  }
  return input;
}

function closeTatClients(clients: WorkbenchTatClients) {
  clients.apiTatFetch.close();
  clients.streamTatFetch.close();
  clients.proxyClient.close();
}

function createTatClients(bootstrap: BotTerminalSession): WorkbenchTatClients {
  const proxyClient = new TencentTsshProxyClient(bootstrap);
  const apiTatFetch = createTatPortFetch(bootstrap, VELAD_VM_PORT, {
    keepAlive: false,
    proxyClient,
    responseHeaderTimeoutMs: 30_000,
  });
  const streamTatFetch = createTatPortFetch(bootstrap, VELAD_VM_PORT, {
    closeDelimitedBodyIdleTimeoutMs: 300_000,
    proxyClient,
    responseHeaderTimeoutMs: 30_000,
  });

  return {
    apiTatFetch,
    bootstrap,
    proxyClient,
    streamTatFetch,
  };
}

export async function createVmWorkbenchVeladTransport({
  botId,
  getTerminalSession,
}: CreateVmWorkbenchVeladTransportInput): Promise<ResolvedWorkbenchVeladTransport> {
  let closed = false;
  let activeClients: WorkbenchTatClients | null = null;
  let activeClientsPromise: Promise<WorkbenchTatClients> | null = null;

  const getClients = () => {
    if (closed) {
      throw new Error("Workbench TAT transport is closed");
    }
    if (!activeClientsPromise) {
      activeClientsPromise = getTerminalSession(botId).then((bootstrap) => {
        const clients = createTatClients(bootstrap);
        activeClients = clients;
        return clients;
      });
    }
    return activeClientsPromise;
  };

  const resetClients = (clients: WorkbenchTatClients | null) => {
    if (clients) {
      closeTatClients(clients);
    }
    if (activeClients === clients) {
      activeClients = null;
      activeClientsPromise = null;
    }
  };

  const recreateClientsFromCurrentLease = (clients: WorkbenchTatClients) => {
    resetClients(clients);
    const nextClients = createTatClients(clients.bootstrap);
    activeClients = nextClients;
    activeClientsPromise = Promise.resolve(nextClients);
    return nextClients;
  };

  const refreshLeaseClients = async (clients: WorkbenchTatClients) => {
    resetClients(clients);
    activeClientsPromise = getTerminalSession(botId).then((bootstrap) => {
      const nextClients = createTatClients(bootstrap);
      activeClients = nextClients;
      return nextClients;
    });
    return activeClientsPromise;
  };

  const logRecovery = (
    action: "refresh_lease" | "reconnect_lease",
    label: "api" | "stream",
    clients: WorkbenchTatClients,
    error: TatTransportError,
  ) => {
    console.log("[workbench-tat] transport recovery", JSON.stringify({
      action,
      botId,
      error: errorForLog(error),
      kind: error.kind,
      label,
      phase: error.phase,
      previousSessionId: clients.bootstrap.sessionId,
    }));
  };

  const fetchWithLeaseRecovery = async (
    label: "api" | "stream",
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const tatInput = asTatFetchInput(input);
    const replaySafe = isReplaySafeRequest(label, init);
    let connectionRetryUsed = false;
    let leaseRefreshUsed = false;

    while (true) {
      const clients = await getClients();
      const tatFetch = label === "api" ? clients.apiTatFetch : clients.streamTatFetch;
      try {
        return await tatFetch(tatInput, init);
      } catch (error) {
        const transportError = normalizeTatTransportError(error, "request");
        if (closed || !transportError.retryable || !replaySafe) {
          throw transportError;
        }

        if (transportError.kind === "lease_expired" && !leaseRefreshUsed) {
          leaseRefreshUsed = true;
          logRecovery("refresh_lease", label, clients, transportError);
          await refreshLeaseClients(clients);
          continue;
        }

        if (
          (transportError.kind === "connection_lost" ||
            transportError.kind === "proxy_unavailable" ||
            transportError.kind === "request_timeout") &&
          !connectionRetryUsed
        ) {
          connectionRetryUsed = true;
          logRecovery("reconnect_lease", label, clients, transportError);
          recreateClientsFromCurrentLease(clients);
          continue;
        }

        throw transportError;
      }
    }
  };

  const apiFetchImpl = ((input, init) =>
    fetchWithLeaseRecovery("api", input, init)) as typeof fetch;
  const streamFetchImpl = ((input, init) =>
    fetchWithLeaseRecovery("stream", input, init)) as typeof fetch;

  return {
    baseUrl: LOCAL_VELAD_BASE_URL,
    client: createVeladClient({ baseUrl: LOCAL_VELAD_BASE_URL, fetch: apiFetchImpl }),
    close: () => {
      closed = true;
      const clients = activeClients;
      const clientsPromise = activeClientsPromise;
      activeClients = null;
      activeClientsPromise = null;
      if (clients) {
        closeTatClients(clients);
      }
      clientsPromise?.then((resolvedClients) => {
        if (resolvedClients !== clients) {
          closeTatClients(resolvedClients);
        }
      }).catch(() => {
        // The page is unmounting; failed lazy initialization has no useful consumer.
      });
    },
    eventStreamTransport: createFetchVelaEventStreamTransport(streamFetchImpl),
    mode: "vm_tat",
  };
}

export function createDirectHttpWorkbenchVeladTransport(
  baseUrl: string,
): ResolvedWorkbenchVeladTransport {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  return {
    baseUrl: normalizedBaseUrl,
    client: createVeladClient({ baseUrl: normalizedBaseUrl }),
    close: () => {},
    mode: "direct_http",
  };
}
