export const VELAD_READY_EVENT_TYPE = "velad.ready";
export const VELAD_LOCAL_RUNTIME_PROTOCOL = "velad.local.v1";
export const VELACHAT_API_PROTOCOL = "velachat.v1";

export interface VeladReadyEvent {
  type: typeof VELAD_READY_EVENT_TYPE;
  runtime_protocol: typeof VELAD_LOCAL_RUNTIME_PROTOCOL;
  api_protocol: typeof VELACHAT_API_PROTOCOL;
  pid: number;
  listen_addr: string;
  api_base_url: string;
  version: string;
}

export type VeladRuntimeStatus = "idle" | "starting" | "ready" | "failed" | "stopping" | "stopped";

export interface VeladRuntimeInfo {
  readyEvent: VeladReadyEvent;
  apiBaseUrl: string;
  listenAddr: string;
}

export interface VeladRuntimeSnapshot {
  status: VeladRuntimeStatus;
  info?: VeladRuntimeInfo;
  error?: string;
}

export function parseVeladReadyLine(line: string): VeladReadyEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(value) || value.type !== VELAD_READY_EVENT_TYPE) return null;
  assertReadyProtocol(value);
  if (
    typeof value.pid !== "number" ||
    typeof value.listen_addr !== "string" ||
    typeof value.api_base_url !== "string" ||
    typeof value.version !== "string"
  ) {
    throw new Error("velad.ready event is missing required fields");
  }
  return value as unknown as VeladReadyEvent;
}

export async function readRuntimeInfo(
  apiBaseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<VeladReadyEvent> {
  const response = await fetchWithTimeout(`${apiBaseUrl}/runtime-info`, fetchImpl, timeoutMs);
  if (!response.ok) {
    throw new Error(`velad runtime-info returned ${response.status}`);
  }
  const value = await response.json();
  if (!isObject(value) || value.type !== VELAD_READY_EVENT_TYPE) {
    throw new Error("velad runtime-info did not return velad.ready");
  }
  assertReadyProtocol(value);
  return value as unknown as VeladReadyEvent;
}

export async function requestRuntimeShutdown(
  apiBaseUrl: string,
  managementToken: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
) {
  const response = await fetchWithTimeout(`${apiBaseUrl}/runtime/shutdown`, fetchImpl, timeoutMs, {
    method: "POST",
    headers: {
      authorization: `Bearer ${managementToken}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`velad runtime shutdown returned ${response.status}`);
  }
}

export function infoFromReadyEvent(readyEvent: VeladReadyEvent): VeladRuntimeInfo {
  return {
    readyEvent,
    apiBaseUrl: readyEvent.api_base_url,
    listenAddr: readyEvent.listen_addr,
  };
}

export function apiBaseUrlFromListenAddr(listenAddr: string) {
  return `http://${listenAddr}/api/v1`;
}

function assertReadyProtocol(value: Record<string, unknown>) {
  if (value.runtime_protocol !== VELAD_LOCAL_RUNTIME_PROTOCOL) {
    throw new Error(`unsupported velad runtime protocol: ${String(value.runtime_protocol)}`);
  }
  if (value.api_protocol !== VELACHAT_API_PROTOCOL) {
    throw new Error(`unsupported velad API protocol: ${String(value.api_protocol)}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  init?: RequestInit,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
