import { randomUUID } from "node:crypto";
import type { ConnectorNativeTool } from "@opencraft/connector-core";
import { ConnectorHostError, record, text, type StoredConnection } from "./store";
import { connectorFetch, jsonResponse } from "./network";
import { KNOWLEDGE_TOOLS, callKnowledge, validateKnowledge } from "./api-knowledge";

// Protocol mappings adapted from Octop ae65fe4 gateway/adapters (MIT; core/NOTICE.md).
const tool = (name: string, description: string, required: string[], optional: string[] = []): ConnectorNativeTool => ({ name, description, readOnly: true,
  inputSchema: { type: "object", properties: Object.fromEntries([...required, ...optional].map(key => [key, { type: "string" }])), required, additionalProperties: false } });
export const API_TOOLS: Readonly<Record<string, readonly ConnectorNativeTool[]>> = {
  ...KNOWLEDGE_TOOLS,
  "tencent-news": [tool("search_news", "搜索腾讯新闻", ["query"])],
  "wechat-reading": [tool("list_bookshelf", "读取微信读书书架", []), tool("get_book_notes", "读取书籍笔记", ["book_id"])],
  "qq-music": [tool("search_music", "搜索歌曲", ["keyword"], ["type"]), tool("list_charts", "查看音乐排行榜", []), tool("get_chart_detail", "读取排行榜", ["top_id"]), tool("get_playlist_detail", "读取歌单", ["diss_id"]), tool("listening_report", "读取听歌报告", [], ["type"])],
  "baidu-map": [tool("search_place", "检索地点", ["query", "region"]), tool("plan_direction", "规划路线", ["query"]), tool("get_weather", "查询城市天气", ["region"])],
  "meituan-travel": [tool("travel_query", "向美团旅游助手查询行程", ["query"], ["city"])],
  "ctrip-wendao": [tool("ask_wendao", "向携程问道查询行程", ["query"])],
};
export const API_DEFINITIONS = Object.keys(API_TOOLS);
export function validateApi(row: StoredConnection): void {
  if (KNOWLEDGE_TOOLS[row.definitionId]) { validateKnowledge(row); return; }
  const key = row.secrets.api_key;
  if (!key || (row.definitionId === "wechat-reading" && !key.startsWith("wrk-")) || (row.definitionId === "qq-music" && !key.startsWith("qmk-"))
    || (row.definitionId === "meituan-travel" && !/^[\da-f]{32,}$/i.test(key)) || (row.definitionId === "ctrip-wendao" && !/^[\da-f]{32}$/i.test(key))) throw new ConnectorHostError("invalid");
}
export async function callApi(row: StoredConnection, name: string, args: Record<string, unknown>, fetchOverride?: typeof fetch): Promise<unknown> {
  if (KNOWLEDGE_TOOLS[row.definitionId]) return callKnowledge(row, name, args, fetchOverride);
  validateApi(row);
  const definition = API_TOOLS[row.definitionId]?.find(tool => tool.name === name); if (!definition) throw new ConnectorHostError("missing");
  const required = definition.inputSchema.required as string[], properties = record(definition.inputSchema.properties);
  for (const key of required) text(args[key], 16000);
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key)) || Object.values(args).some(value => typeof value !== "string" || value.length > 16000)) throw new ConnectorHostError("invalid");
  let url = "", method = "POST", body: unknown = {}, plain = false;
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${row.secrets.api_key}`, "User-Agent": "opencraft-connector/0.1" };
  switch (row.definitionId) {
    case "tencent-news": { const requestId = randomUUID(); url = "https://openapi.inews.qq.com/api/v1/agent/search";
      headers["Skill-Request-Id"] = requestId; headers["Caller-Skill"] = "opencraft_tencent-news_0.1";
      body = { page: 1, page_size: 10, is_show_content: 0, query: { query_id: requestId, search: args.query }, article_types: [0] }; break; }
    case "wechat-reading": url = "https://i.weread.qq.com/api/agent/gateway"; body = { api_name: name === "list_bookshelf" ? "/shelf/sync" : "/book/bookmarklist", skill_version: "1.0.3", ...(args.book_id ? { bookId: args.book_id } : {}) }; break;
    case "qq-music": {
      const paths: Record<string, string> = { search_music: "/discover/search", list_charts: "/charts", get_chart_detail: "/charts/detail", get_playlist_detail: "/playlists/detail", listening_report: "/me/report" };
      url = `https://a.y.qq.com${paths[name]}`;
      const params = name === "search_music" ? { keyword: args.keyword, type: args.type ?? "0" } : name === "get_chart_detail" ? { topId: Number(args.top_id) } : name === "get_playlist_detail" ? { dissId: Number(args.diss_id) } : args;
      body = { params, comm: { skill_version: "0.0.3" } }; break;
    }
    case "baidu-map": {
      const path = name === "search_place" ? "place" : name === "plan_direction" ? "direction" : "weather";
      const query = new URLSearchParams(); if (args.query) query.set("user_raw_request", String(args.query)); if (args.region) query.set("region", String(args.region));
      url = `https://api.map.baidu.com/agent_plan/v1/${path}?${query}`; method = "GET"; break;
    }
    case "meituan-travel": url = "https://mcp-open-cater.meituan.com/v1/api/voyage/openapi/query"; headers.Authorization = row.secrets.api_key; body = { query: args.query, city: args.city ?? "北京" }; break;
    case "ctrip-wendao": url = "https://wendao-skill-prod.ctrip.com/skill/query"; delete headers.Authorization; body = { token: row.secrets.api_key, query: args.query, source: "opencraft" }; plain = true; break;
    default: throw new ConnectorHostError("unsupported");
  }
  const response = await (fetchOverride ?? connectorFetch([new URL(url).origin]))(url, { method, headers, ...(method === "POST" ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90000) });
  if (plain) { if (!response.ok) throw new ConnectorHostError("unavailable"); const value = await response.text(); if (!value || value.length > 262144) throw new ConnectorHostError("unavailable"); return value; }
  const result = await jsonResponse(response), data = record(result);
  const status = row.definitionId === "tencent-news" ? (data.base_rsp ? record(data.base_rsp).code : undefined) : data.errcode ?? data.errCode ?? data.ret ?? data.code ?? data.status;
  if (status !== undefined && status !== null && status !== 0 && status !== "0") throw new ConnectorHostError("unavailable");
  return result;
}
