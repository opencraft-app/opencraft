import type { StoredConnection } from "./store";
import { ConnectorHostError } from "./store";

export const OAUTH_SERVICES: Readonly<Record<string, { issuer: string; url: string; resource?: string }>> = {
  notion: { issuer: "https://mcp.notion.com", url: "https://mcp.notion.com/mcp" },
  "tencent-ardot": { issuer: "https://ardot.tencent.com", url: "https://ardot.tencent.com/mcp", resource: "https://ardot.tencent.com/mcp" },
  dida365: { issuer: "https://dida365.com", url: "https://mcp.dida365.com", resource: "https://mcp.dida365.com/" },
};
export const MCP_DEFINITIONS = ["tencent-docs", "tencent-meeting", "tencent-weiyun", "tencent-lexiang", "youdao-note", "didi", "dify", ...Object.keys(OAUTH_SERVICES)];
export function mcpEndpoint(row: StoredConnection): { url: string; headers: Record<string, string>; sse?: boolean; private?: boolean } {
  const { secrets: s, values: v, definitionId: id } = row;
  const oauth = OAUTH_SERVICES[id];
  if (oauth) return { url: oauth.url, headers: {} };
  if (id === "tencent-docs") return { url: "https://docs.qq.com/openapi/mcp", headers: { Authorization: s.token } };
  if (id === "tencent-meeting") return { url: "https://mcp.meeting.tencent.com/mcp/wemeet-open/v1", headers: { "X-Tencent-Meeting-Token": s.token, "X-Skill-Version": "v1.0.1" } };
  if (id === "tencent-weiyun") return { url: "https://www.weiyun.com/api/v3/mcpserver", headers: { WyHeader: `mcp_token=${s.token.replace(/^mcp_token=/, "")}` } };
  if (id === "tencent-lexiang") return { url: `https://mcp.lexiang-app.com/mcp?preset=meta&company_from=${encodeURIComponent(v.company_from)}`, headers: { Authorization: `Bearer ${s.api_key}` } };
  if (id === "youdao-note") return { url: "https://open.mail.163.com/api/ynote/mcp/sse", headers: { "x-api-key": s.token }, sse: true };
  if (id === "didi") return { url: `https://mcp.didichuxing.com/mcp-servers?key=${encodeURIComponent(s.api_key)}`, headers: {} };
  if (id === "dify") {
    const url = new URL(s.mcp_url);
    if (!/^\/mcp\/server\/[^/]+\/mcp\/?$/.test(url.pathname)) throw new ConnectorHostError("invalid");
    return { url: url.href, headers: {}, private: true };
  }
  throw new ConnectorHostError("unsupported");
}
