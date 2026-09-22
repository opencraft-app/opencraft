import type { ConnectorNativeTool } from "@opencraft/connector-core";
import { ConnectorHostError, record, text, type StoredConnection } from "./store";
import { connectorFetch, jsonResponse } from "./network";

const tool = (name: string, description: string, required: string[], optional: string[] = [], readOnly = true): ConnectorNativeTool => ({ name, description, readOnly,
  inputSchema: { type: "object", properties: Object.fromEntries([...required, ...optional].map(key => [key, { type: "string" }])), required, additionalProperties: false } });
export const KNOWLEDGE_TOOLS: Readonly<Record<string, readonly ConnectorNativeTool[]>> = {
  "tencent-ima": [tool("list_notebooks", "列出 IMA 笔记本", [], ["cursor"]), tool("list_notes", "列出 IMA 笔记", [], ["folder_id", "cursor"]), tool("get_note", "读取 IMA 笔记", ["note_id"]), tool("search_notes", "按标题搜索 IMA 笔记", ["query"]),
    tool("create_note", "创建 IMA 笔记", ["content"], ["folder_id"], false), tool("append_note", "追加 IMA 笔记", ["note_id", "content"], [], false),
    tool("list_knowledge_bases", "列出 IMA 知识库", [], ["query", "cursor"]), tool("list_knowledge", "列出知识库内容", ["knowledge_base_id"], ["cursor", "folder_id"]), tool("search_knowledge", "检索知识库", ["knowledge_base_id", "query"], ["cursor"]), tool("get_media", "读取知识库资料", ["media_id"])],
  yuandian: [tool("search_laws", "检索法律法规", ["query"]), tool("search_cases", "检索案例", ["query"]), tool("search_enterprises", "检索企业候选", ["name"]), tool("get_enterprise", "获取企业资料", ["name"]), tool("detect_hallucination", "核验文本中的法律引用", ["text"])],
  weknora: [tool("list_knowledge_bases", "列出可访问的 WeKnora 知识库", []), tool("search", "检索知识库，knowledge_base_ids 为逗号分隔的 ID，省略则查询当前凭据可见知识库", ["query"], ["knowledge_base_ids"]), tool("read_document", "读取文档及前 20 个有序片段", ["knowledge_id"])],
};
export function validateKnowledge(row: StoredConnection) {
  if (row.definitionId === "weknora") {
    const url = new URL(row.values.base_url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ConnectorHostError("invalid");
  } else {
    text(row.secrets.api_key, 32768);
    if (row.definitionId === "tencent-ima") text(row.values.client_id);
    if (row.definitionId === "yuandian" && !row.secrets.api_key.startsWith("sk_")) throw new ConnectorHostError("invalid");
  }
}
export async function callKnowledge(row: StoredConnection, name: string, args: Record<string, unknown>, fetchOverride?: typeof fetch): Promise<unknown> {
  validateKnowledge(row);
  const definition = KNOWLEDGE_TOOLS[row.definitionId]?.find(tool => tool.name === name); if (!definition) throw new ConnectorHostError("missing");
  for (const key of definition.inputSchema.required as string[]) text(args[key], 16000);
  if (Object.keys(args).some(key => !Object.hasOwn(record(definition.inputSchema.properties), key)) || Object.values(args).some(value => typeof value !== "string" || value.length > 16000)) throw new ConnectorHostError("invalid");
  const send = async (url: string, method: string, headers: Record<string, string>, body?: unknown) => {
    const value = record(await jsonResponse(await (fetchOverride ?? connectorFetch([new URL(url).origin], row.definitionId === "weknora"))(url, {
      method, headers: { ...headers, Accept: "application/json", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000),
    })));
    if (value.success === false || (value.code !== undefined && value.code !== 0 && value.code !== "0")) throw new ConnectorHostError("unavailable");
    return value;
  };
  if (row.definitionId === "tencent-ima") {
    let path = "", body: Record<string, unknown> = {};
    switch (name) {
      case "list_notebooks": path = "note/v1/list_notebook"; body = { cursor: args.cursor ?? "0", limit: 20 }; break;
      case "list_notes": path = "note/v1/list_note"; body = { ...args, cursor: args.cursor ?? "", limit: 20 }; break;
      case "get_note": path = "note/v1/get_doc_content"; body = { note_id: args.note_id, target_content_format: 0 }; break;
      case "search_notes": path = "note/v1/search_note"; body = { search_type: 0, query_info: { title: args.query }, start: 0, end: 20 }; break;
      case "create_note": path = "note/v1/import_doc"; body = { ...args, content_format: 1 }; break;
      case "append_note": path = "note/v1/append_doc"; body = { ...args, content_format: 1 }; break;
      case "list_knowledge_bases": path = "wiki/v1/search_knowledge_base"; body = { query: args.query ?? "", cursor: args.cursor ?? "", limit: 20 }; break;
      case "list_knowledge": path = "wiki/v1/get_knowledge_list"; body = { ...args, cursor: args.cursor ?? "", limit: 20 }; break;
      case "search_knowledge": path = "wiki/v1/search_knowledge"; body = { ...args, cursor: args.cursor ?? "" }; break;
      case "get_media": path = "wiki/v1/get_media_info"; body = { media_id: args.media_id }; break;
      default: throw new ConnectorHostError("missing");
    }
    return send(`https://ima.qq.com/openapi/${path}`, "POST", { "ima-openapi-clientid": row.values.client_id, "ima-openapi-apikey": row.secrets.api_key }, body);
  }
  if (row.definitionId === "yuandian") {
    const routes: Record<string, string> = { search_laws: "law_vector_search", search_cases: "case_vector_search", search_enterprises: "rh_enterpriseSearch", get_enterprise: "rh_company_info", detect_hallucination: "hall_detect" };
    const isGet = name === "search_enterprises" || name === "get_enterprise";
    const query = isGet ? `?${new URLSearchParams({ name: String(args.name), ...(name === "search_enterprises" ? { top_k: "10" } : { num: "2" }) })}` : "";
    return send(`https://open.chineselaw.com/open/${routes[name]}${query}`, isGet ? "GET" : "POST", { "X-API-Key": row.secrets.api_key }, isGet ? undefined : { ...args, ...(name === "search_laws" ? { return_num: 10 } : {}) });
  }
  const base = row.values.base_url.replace(/\/$/, "").replace(/\/api\/v1$/, "") + "/api/v1";
  const headers: Record<string, string> = {}; if (row.secrets.api_key) headers["X-API-Key"] = row.secrets.api_key; if (row.values.tenant_id) headers["X-Tenant-ID"] = row.values.tenant_id;
  if (name === "list_knowledge_bases") return send(`${base}/knowledge-bases`, "GET", headers);
  if (name === "read_document") {
    const id = encodeURIComponent(String(args.knowledge_id));
    const [document, chunks] = await Promise.all([send(`${base}/knowledge/${id}`, "GET", headers), send(`${base}/chunks/${id}?page=1&page_size=20`, "GET", headers)]);
    return { document: document.data, chunks: chunks.data };
  }
  let ids = String(args.knowledge_base_ids ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!ids.length) { const value = await send(`${base}/knowledge-bases`, "GET", headers); ids = Array.isArray(value.data) ? value.data.map(row => String(record(row).id)).filter(Boolean) : []; }
  if (!ids.length) throw new ConnectorHostError("unavailable");
  const value = await send(`${base}/knowledge-search?resource_urls=handle`, "POST", headers, { query: args.query, knowledge_base_ids: ids });
  return { ...value, data: Array.isArray(value.data) ? value.data.slice(0, 8).map(row => ({ ...record(row), content: String(record(row).content ?? "").slice(0, 1200) })) : value.data };
}
