import type { BotTerminalSession } from "../domain/types";
import {
  createTatHermesWebFetch,
  type TatHttpVirtualFetch,
} from "./tat-http-virtual-client";
import type { TencentTatSessionMultiplexer } from "./tencent-tat-session-multiplexer";

const INJECTED_TOKEN_PATTERN = /window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:\\.|[^"\\])*")/;

export interface HermesDashboardSessionOptions {
  createFetch?: (bootstrap: BotTerminalSession) => TatHttpVirtualFetch;
  proxyClient?: TencentTatSessionMultiplexer;
  sessionToken?: string;
}

export const extractHermesDashboardSessionToken = (html: string) => {
  const encoded = INJECTED_TOKEN_PATTERN.exec(html)?.[1];
  if (!encoded) {
    return null;
  }
  try {
    const token = JSON.parse(encoded) as unknown;
    return typeof token === "string" && token.trim() ? token : null;
  } catch {
    return null;
  }
};

export const resolveHermesDashboardWebSocketUrl = async (
  bootstrap: BotTerminalSession,
  targetUrl: string | URL,
  options: HermesDashboardSessionOptions = {},
) => {
  const resolved = new URL(String(targetUrl));
  const resolvedPort = resolved.port || "80";
  if (resolved.protocol !== "ws:" || resolved.hostname !== "127.0.0.1" || resolvedPort !== "9119") {
    throw new DOMException(
      "Hermes dashboard WebSocket target must be ws://127.0.0.1:9119.",
      "SecurityError",
    );
  }
  if (options.sessionToken?.trim()) {
    resolved.searchParams.set("token", options.sessionToken.trim());
    return resolved;
  }
  const tatFetch = options.createFetch?.(bootstrap) ?? createTatHermesWebFetch(bootstrap, {
    proxyClient: options.proxyClient,
  });
  try {
    const response = await tatFetch("/", { method: "GET" });
    if (!response.ok) {
      throw new Error(`Hermes dashboard index returned HTTP ${response.status}.`);
    }
    const token = extractHermesDashboardSessionToken(await response.text());
    if (!token) {
      throw new Error("Hermes dashboard did not expose a session token.");
    }
    resolved.searchParams.set("token", token);
    return resolved;
  } finally {
    tatFetch.close();
  }
};
