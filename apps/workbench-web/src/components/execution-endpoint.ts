import type { HostConnectionProfile } from "@opencraft/workbench-runtime";

/** Display connection addresses without credentials; native Host labels stay readable. */
export function executionEndpoint(
  profile: Pick<HostConnectionProfile, "providerConfig" | "transportEndpoint">,
  baseUrl: string,
): string {
  const address = (url: URL) => {
    const protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
    return `${protocol}//${url.host}${url.pathname}`;
  };
  const config = profile.providerConfig;
  if (typeof config === "object" && config !== null && !Array.isArray(config) && "url" in config && typeof config.url === "string") {
    try { return address(new URL(config.url, baseUrl)); }
    catch { return "连接地址不可用"; }
  }
  const endpoint = profile.transportEndpoint;
  if (endpoint === null) return "由宿主提供";
  // Preserve plain native labels. Address syntax (including query/hash on a
  // bare relative path) always takes the URL projection, never a raw fallback.
  if (!/[/?#]|^[a-z][a-z0-9+.-]*:/iu.test(endpoint)) return endpoint;
  try { return address(new URL(endpoint, baseUrl)); }
  catch { return "连接地址不可用"; }
}
