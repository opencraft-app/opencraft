import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as request } from "undici";
import { ConnectorHostError } from "./store";

const deniedAddress = (address: string) => {
  const value = address.toLowerCase();
  return value === "::" || value.startsWith("fe80:") || value.startsWith("ff") || value.startsWith("::ffff:")
    || /^(0|169\.254|224|239)\./.test(value) || value === "100.100.100.200";
};
/** Pin DNS resolution into the actual connection; never forward credentials on redirects. */
export function connectorFetch(allowedOrigins: readonly string[], allowPrivate = false): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!allowedOrigins.includes(url.origin) || url.username || url.password || !["https:", "http:"].includes(url.protocol)) throw new ConnectorHostError("invalid");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => deniedAddress(address))) throw new ConnectorHostError("invalid");
    if (!allowPrivate && addresses.some(({ address }) => /^(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(address) || address === "::1" || /^f[cd]/i.test(address))) throw new ConnectorHostError("invalid");
    if (url.protocol === "http:" && !allowPrivate) throw new ConnectorHostError("invalid");
    const pinned = addresses[0];
    const agent = new Agent({ connect: { lookup: (_host, options, callback) => {
      if (options.all) callback(null, addresses as never); else callback(null, pinned.address, pinned.family);
    } } });
    try {
      const response = await request(url, { ...init, redirect: "manual", dispatcher: agent,
        signal: init?.signal ?? AbortSignal.timeout(30000) } as Parameters<typeof request>[1]);
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ConnectorHostError("unavailable"); }
      // close() drains active streams; it does not abort the returned SSE body.
      void agent.close().catch(() => undefined);
      return response as unknown as Response;
    } catch (error) { void agent.destroy(); throw error; }
  };
}

export async function jsonResponse(response: Response): Promise<unknown> {
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ConnectorHostError("authorization-required"); }
  if (!response.ok) { await response.body?.cancel(); throw new ConnectorHostError("unavailable"); }
  const reader = response.body?.getReader(); if (!reader) throw new ConnectorHostError("unavailable");
  let result = ""; const decoder = new TextDecoder();
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; result += decoder.decode(chunk.value, { stream: true }); if (result.length > 262144) throw new ConnectorHostError("unavailable"); } }
  finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(result + decoder.decode());
}
