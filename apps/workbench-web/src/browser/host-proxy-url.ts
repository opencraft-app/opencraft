import { serverUrl } from "../runtime/server-context";
import type { BrowserUrl } from "@opencraft/browser-core";

export const HOST_PROXY_PATH_PREFIX = serverUrl("/__opencraft/host-proxy/v1");
export const HOST_PROXY_SERVICE_WORKER_URL = serverUrl("/__opencraft/opencraft-host-proxy-sw.js");
export const HOST_PROXY_SERVICE_WORKER_SCOPE = serverUrl("/__opencraft/host-proxy/");

export interface HostProxyRoute {
  readonly brokerId: string;
  readonly hostId: string;
  readonly targetUrl: string;
}

const loopbackNames = new Set(["localhost", "0.0.0.0", "::1", "[::1]"]);

export function isLoopbackHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "http:" && (
      loopbackNames.has(url.hostname)
      || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function encodeHostProxyUrl(input: {
  readonly appOrigin: string;
  readonly brokerId: string;
  readonly hostId: string;
  readonly targetUrl: string;
}): BrowserUrl {
  const target = new URL(input.targetUrl);
  if (!isLoopbackHttpUrl(target.href)) {
    throw new TypeError("Host proxy targets must be plain HTTP loopback URLs");
  }
  const path = target.pathname.startsWith("/") ? target.pathname : `/${target.pathname}`;
  return new URL(
    `${HOST_PROXY_PATH_PREFIX}/${segment(input.brokerId)}/${segment(input.hostId)}`
      + `/http/${segment(target.host)}${path}${target.search}${target.hash}`,
    input.appOrigin,
  ).href as BrowserUrl;
}

export function decodeHostProxyUrl(input: string): HostProxyRoute | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const prefix = `${HOST_PROXY_PATH_PREFIX}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const parts = url.pathname.slice(prefix.length).split("/");
  if (parts.length < 4 || parts[2] !== "http") return null;
  try {
    const brokerId = decodeURIComponent(parts[0]!);
    const hostId = decodeURIComponent(parts[1]!);
    const authority = decodeURIComponent(parts[3]!);
    if (!brokerId || !hostId || !authority) return null;
    const pathname = `/${parts.slice(4).join("/")}`;
    const targetUrl = `http://${authority}${pathname}${url.search}${url.hash}`;
    if (!isLoopbackHttpUrl(targetUrl)) return null;
    return { brokerId, hostId, targetUrl };
  } catch {
    return null;
  }
}
