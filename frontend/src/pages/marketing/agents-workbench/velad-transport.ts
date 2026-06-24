import { createTatPortFetch } from "@/lib/tat-http-virtual-client";
import { TencentTsshProxyClient } from "@/lib/tencent-tssh-proxy-client";
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

export async function createVmWorkbenchVeladTransport({
  botId,
  getTerminalSession,
}: CreateVmWorkbenchVeladTransportInput): Promise<ResolvedWorkbenchVeladTransport> {
  const bootstrap = await getTerminalSession(botId);
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
  const apiFetchImpl = apiTatFetch as unknown as typeof fetch;
  const streamFetchImpl = streamTatFetch as unknown as typeof fetch;

  return {
    baseUrl: LOCAL_VELAD_BASE_URL,
    client: createVeladClient({ baseUrl: LOCAL_VELAD_BASE_URL, fetch: apiFetchImpl }),
    close: () => {
      apiTatFetch.close();
      streamTatFetch.close();
      proxyClient.close();
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
