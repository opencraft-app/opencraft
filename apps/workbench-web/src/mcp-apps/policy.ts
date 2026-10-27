import { record } from "./contract";

export interface AppResource {
  readonly html: string;
  readonly csp: { connectDomains: string[]; resourceDomains: string[] };
}
function origins(value: unknown, connect = false): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid App CSP domains");
  return value.map(entry => {
    if (typeof entry !== "string") throw new Error("Invalid App CSP origin");
    const wildcard = entry.includes("://*.");
    const url = new URL(wildcard ? entry.replace("://*.", "://app.") : entry);
    if (!(connect ? ["https:", "wss:", "http:", "ws:"] : ["https:", "http:"]).includes(url.protocol)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !/^[-a-zA-Z0-9.*:/\[\]]+$/.test(entry) || (entry.includes("*") && !/^https?:\/\/\*\.[a-zA-Z0-9.-]+(?::[0-9]+)?\/?$/.test(entry))) throw new Error("Invalid App CSP origin");
    return wildcard ? url.origin.replace("://app.", "://*.") : url.origin;
  });
}
export function readAppResource(value: unknown, uri: string, callId: string | null): AppResource {
  if (!uri.startsWith("ui://")) throw new Error("MCP App resources must use ui://");
  const result = record(value);
  if (result.originCallId != null && result.originCallId !== callId) throw new Error("App resource provenance mismatch");
  const content = Array.isArray(result.contents) ? result.contents.find(entry => record(entry).uri === uri) : undefined;
  const item = record(content);
  if (typeof item.mimeType !== "string" || !/^text\/html(?:\s*;|$)/i.test(item.mimeType)
    || typeof item.text !== "string" || item.text.length > 1048576) throw new Error("Invalid MCP App HTML resource");
  const meta = record(item._meta);
  const csp = record(record(meta.ui).csp ?? meta["openai/widgetCSP"]);
  return { html: item.text, csp: {
    connectDomains: origins(csp.connectDomains ?? csp.connect_domains, true),
    resourceDomains: origins(csp.resourceDomains ?? csp.resource_domains),
  } };
}
export function appCsp(resource: AppResource): string {
  const resources = resource.csp.resourceDomains.join(" ");
  const connections = resource.csp.connectDomains.join(" ") || "'none'";
  return `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: blob: ${resources}; font-src data: ${resources}; media-src data: blob: ${resources}; connect-src ${connections}; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
