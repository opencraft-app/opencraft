import { Service, type Inject } from "@deepseek-ai/cordis";
import { sha256 } from "@noble/hashes/sha256";
import { utf8Encode } from "../runtime/bytes.ts";
import type { AppServerConnection } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { McpAppBuilderPort } from "../types/mcp-app-builder.ts";
import type {
  McpAppLaunchRequest,
  McpServerRegistration,
  McpToolCallResult,
  McpToolRegistration,
} from "../types/mcp.ts";

export const MCP_APP_BUILDER_SERVER_NAME = "hypernode-app-builder";
export const MCP_APP_BUILDER_RESOURCE_URI = "ui://hypernode/app-builder/v1.html";

type Dependencies = "mcpRegistry" | "storage" | "virtualSkills";
type ToolHandler =
  | { kind: "echo"; text?: string }
  | { kind: "static"; structuredContent?: unknown; text?: string }
  | { kind: "javascript"; source: string };

export interface DynamicMcpToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  readOnlyHint?: boolean;
  handler: ToolHandler;
}

export interface DynamicMcpAppSpec {
  appId: string;
  title: string;
  description: string;
  uiHtml: string;
  entryTool: string;
  skillDescription?: string;
  tools: DynamicMcpToolSpec[];
}

interface AppRecord {
  appId: string;
  ownerId: string;
  activeRevision: number | null;
  nextRevision: number;
  draft: DynamicMcpAppSpec;
}

export interface DynamicMcpAppRelease {
  appId: string;
  ownerId: string;
  revision: number;
  uiDigest: string;
  uiResourceUri: string;
  spec: DynamicMcpAppSpec;
  publishedAtMs: number;
}

interface AppSqlRow extends Record<string, string | number | boolean | Uint8Array | null> {
  app_id: string;
  owner_id: string;
  active_revision: number | null;
  next_revision: number;
  draft_json: string;
}

interface ReleaseSqlRow extends Record<string, string | number | boolean | Uint8Array | null> {
  app_id: string;
  owner_id: string;
  revision: number;
  ui_digest: string;
  ui_resource_uri: string;
  spec_json: string;
  published_at_ms: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, key: string, max: number): string {
  const candidate = isRecord(value) ? value[key] : undefined;
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  if (candidate.length > max) throw new RangeError(`${key} is too long`);
  return candidate.trim();
}

function sha256Hex(value: string): string {
  return Array.from(sha256(utf8Encode(value)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function identity(connection: AppServerConnection): string {
  const actor = connection.identity?.id;
  if (typeof actor !== "string" || actor.length === 0) {
    throw Object.assign(new Error("an authenticated SSH identity is required"), { code: -32001 });
  }
  return actor;
}

function jsonSchema(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${key} must be a JSON schema object`);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function validateDynamicMcpAppSpec(value: unknown): DynamicMcpAppSpec {
  if (!isRecord(value)) throw new TypeError("spec must be an object");
  const appId = text(value, "appId", 40).toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(appId)) {
    throw new TypeError("appId must be 2-40 lowercase letters, digits, or hyphens and start with a letter");
  }
  const uiHtml = text(value, "uiHtml", 512_000);
  if (!/^\s*<!doctype html>/i.test(uiHtml)) throw new TypeError("uiHtml must be a complete HTML document");
  if (!/window\.openai/.test(uiHtml)) throw new TypeError("uiHtml must use the window.openai MCP Apps bridge");
  if (/<script\b[^>]*\bsrc\s*=/i.test(uiHtml)) throw new TypeError("uiHtml must be self-contained without external scripts");
  if (!Array.isArray(value["tools"]) || value["tools"].length === 0 || value["tools"].length > 16) {
    throw new TypeError("tools must contain 1-16 tools");
  }
  const names = new Set<string>();
  const tools = value["tools"].map((candidate, index): DynamicMcpToolSpec => {
    if (!isRecord(candidate)) throw new TypeError(`tools[${index}] must be an object`);
    const name = text(candidate, "name", 80);
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) || names.has(name)) {
      throw new TypeError(`tools[${index}].name is invalid or duplicated`);
    }
    names.add(name);
    const rawHandler = candidate["handler"];
    if (!isRecord(rawHandler) || !["echo", "static", "javascript"].includes(String(rawHandler["kind"]))) {
      throw new TypeError(`tools[${index}].handler.kind must be echo, static, or javascript`);
    }
    let handler: ToolHandler;
    if (rawHandler["kind"] === "echo") {
      handler = {
        kind: "echo",
        ...(typeof rawHandler["text"] === "string" ? { text: rawHandler["text"].slice(0, 4_000) } : {}),
      };
    } else if (rawHandler["kind"] === "static") {
      handler = {
        kind: "static",
        ...(rawHandler["structuredContent"] === undefined
          ? {}
          : { structuredContent: JSON.parse(JSON.stringify(rawHandler["structuredContent"])) }),
        ...(typeof rawHandler["text"] === "string" ? { text: rawHandler["text"].slice(0, 4_000) } : {}),
      };
    } else {
      const source = text(rawHandler, "source", 50_000);
      compileJavascriptHandler(source);
      handler = { kind: "javascript", source };
    }
    return {
      name,
      title: text(candidate, "title", 120),
      description: text(candidate, "description", 500),
      inputSchema: jsonSchema(candidate["inputSchema"], `tools[${index}].inputSchema`),
      ...(candidate["outputSchema"] === undefined
        ? {}
        : { outputSchema: jsonSchema(candidate["outputSchema"], `tools[${index}].outputSchema`) }),
      readOnlyHint: candidate["readOnlyHint"] !== false,
      handler,
    };
  });
  const entryTool = text(value, "entryTool", 80);
  if (!names.has(entryTool)) throw new TypeError("entryTool must name one of tools");
  return {
    appId,
    title: text(value, "title", 120),
    description: text(value, "description", 500),
    uiHtml,
    entryTool,
    ...(typeof value["skillDescription"] === "string"
      ? { skillDescription: value["skillDescription"].slice(0, 500) }
      : {}),
    tools,
  };
}

function toolResult(structuredContent: unknown, message?: string): McpToolCallResult {
  const rendered = message ?? (typeof structuredContent === "string"
    ? structuredContent
    : JSON.stringify(structuredContent));
  return {
    content: [{ type: "text", text: rendered }],
    structuredContent,
  };
}

interface DynamicJavascriptContext {
  appId: string;
  revision: number;
  server: string;
  tool: string;
  threadId: string;
  principalId: string | null;
}

type DynamicJavascriptHandler = (
  argumentsValue: unknown,
  context: Readonly<DynamicJavascriptContext>,
) => unknown;

export function compileJavascriptHandler(source: string): DynamicJavascriptHandler {
  // App authors explicitly opt into code running inside Hypernode's QuickJS
  // policy realm. Compilation happens before a release is activated, so a
  // syntax error can never replace the active revision.
  const compiled = Function("args", "context", `"use strict";\n${source}`) as DynamicJavascriptHandler;
  return (argumentsValue, context) => compiled(argumentsValue, Object.freeze({ ...context }));
}

function javascriptToolResult(value: unknown): McpToolCallResult {
  if (isRecord(value) && Array.isArray(value["content"])) {
    const content = value["content"].filter(isRecord);
    return {
      content,
      ...(value["structuredContent"] === undefined ? {} : { structuredContent: value["structuredContent"] }),
      ...(typeof value["isError"] === "boolean" ? { isError: value["isError"] } : {}),
      ...(value["_meta"] === undefined ? {} : { _meta: value["_meta"] }),
    };
  }
  if (isRecord(value) && "structuredContent" in value) {
    const structuredContent = value["structuredContent"];
    const message = typeof value["text"] === "string" ? value["text"] : undefined;
    return toolResult(structuredContent, message);
  }
  return toolResult(value ?? null);
}

function toolMeta(uri: string, entrypoint = false): Record<string, unknown> {
  return {
    ui: { resourceUri: uri, visibility: entrypoint ? ["global", "thread"] : ["thread"] },
    "ui/resourceUri": uri,
    "openai/outputTemplate": uri,
    ...(entrypoint ? { "openai/ui": { entrypoints: ["global", "thread"] } } : {}),
  };
}

export const MCP_APP_AGENT_BODY = `# Build MCP App

This is a DSH-only capability. Turn the user's natural-language request into a finished MCP App inside the DSH Agent. Do the design and implementation yourself. Never ask the user to hand-write HTML, JSON schemas, or JavaScript, and never create a standalone MCP project in the workspace.

## Workflow

1. Read [references/ui-quality.md](references/ui-quality.md) before generating UI.
2. Call \`manage_mcp_app\` with \`action: "list"\` or \`"get"\`. If the request modifies an existing App, preserve its working behavior unless the user asks otherwise. For an unpublish or delete request, call that action directly with \`app_id\`; deletion does not require a confirmation turn.
3. Infer a concise lowercase-hyphenated \`appId\`, product title, focused tools, JSON Schemas, complete self-contained HTML, and backend handlers from the request. Do not stop for cosmetic choices; make strong defaults.
4. Call \`manage_mcp_app\` with \`action: "validate"\` and the serialized spec in \`spec_json\`. Repair every validation error yourself.
5. Call \`manage_mcp_app\` once with \`action: "publish"\` and \`spec_json\`. Never run shell commands, install packages, or create a Python/Node MCP project—the Hypernode Builder is the runtime and publisher.

The spec shape is:

\`{ appId, title, description, skillDescription?, uiHtml, entryTool, tools }\`.

Each tool is:

\`{ name, title, description, inputSchema, outputSchema?, readOnlyHint?, handler }\`.

Prefer \`handler: { kind: "javascript", source }\` for real behavior. \`source\` is a JavaScript function body with \`args\` and immutable \`context\` in scope and must return either structured data, \`{ structuredContent, text? }\`, or a complete MCP result. It executes inside the server QuickJS realm. Use \`echo\` or \`static\` only when that is genuinely the requested behavior.

The HTML must call its tools through \`window.openai.callTool(toolName, arguments)\`, render \`structuredContent\`, be responsive, and include useful loading, empty, success, and error states. It must not load external scripts.

Publishing rules:

- Treat every publish as an immutable release \`rN\`.
- A UI content change must produce a new content-addressed resource URI.
- A backend-only change may reuse the previous UI URI.
- Publish only after validation succeeds; use rollback to atomically point at an older release.
- Use \`unpublish\` to remove the live MCP server and launcher while retaining its draft and releases. Use \`delete\` to permanently remove the App and all releases.
`;

export const MCP_APP_AGENT_INSTRUCTIONS = `---
name: build-mcp-app
description: Turn a one-sentence product request into a polished, working Hypernode MCP App; also revise, publish, roll back, unpublish, or delete an existing App.
---

${MCP_APP_AGENT_BODY}`;

const UI_QUALITY_REFERENCE = `# MCP App UI quality

Design a compact, intentional application rather than a generic card demo. Establish hierarchy with typography, spacing, and one restrained accent color. Use semantic HTML, keyboard-accessible controls, visible focus states, responsive layout, and both light and dark color schemes. Prefer system fonts and self-contained SVG icons. Avoid excessive gradients, floating decorative shapes, nested cards, tiny text, gratuitous animation, external scripts, and placeholder controls. Give loading, empty, success, and error states real copy. Never use ResizeObserver merely to size the root document; let normal layout determine height. All privileged or network work belongs in MCP tools, not the iframe. The iframe communicates through window.openai.callTool and renders structuredContent.
`;

export const MCP_APP_BUILDER_HTML = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:Canvas;--fg:CanvasText;--muted:color-mix(in srgb,CanvasText 58%,transparent);--line:color-mix(in srgb,CanvasText 16%,transparent);--soft:color-mix(in srgb,CanvasText 5%,Canvas);--accent:#5b45e0;--danger:#c9362b}*{box-sizing:border-box}body{margin:0;padding:14px;background:transparent;color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}.shell{max-width:920px;margin:auto;border:1px solid var(--line);border-radius:18px;background:var(--bg);overflow:hidden}.head{padding:20px 22px 16px;display:flex;gap:12px;justify-content:space-between;border-bottom:1px solid var(--line)}h1{font-size:20px;margin:0;letter-spacing:-.02em}.sub{color:var(--muted);font-size:12px;margin:4px 0 0}.badge{align-self:flex-start;border-radius:999px;padding:5px 9px;background:color-mix(in srgb,var(--accent) 12%,Canvas);color:var(--accent);font-size:11px;font-weight:700}.body{display:grid;grid-template-columns:210px minmax(0,1fr);min-height:480px}.side{padding:14px;border-right:1px solid var(--line);background:var(--soft)}.apps{display:grid;gap:6px;margin-top:12px}.app{border:0;border-radius:9px;padding:9px;text-align:left;background:transparent;color:inherit;cursor:pointer}.app.active,.app:hover{background:color-mix(in srgb,var(--accent) 10%,Canvas)}button{font:inherit}.new,.primary,.secondary{min-height:38px;border-radius:9px;padding:0 12px;cursor:pointer}.new,.primary{border:0;background:var(--accent);color:white;font-weight:650}.new{width:100%}.secondary{border:1px solid var(--line);background:Canvas;color:inherit}.editor{padding:18px;min-width:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{display:grid;gap:6px;margin-bottom:12px}.full{grid-column:1/-1}label{font-size:12px;color:var(--muted);font-weight:650}input,textarea{width:100%;border:1px solid var(--line);border-radius:9px;background:Canvas;color:inherit;padding:9px 10px;font:inherit}textarea{min-height:108px;resize:vertical;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}#html{min-height:190px}input:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.status{margin-left:auto;color:var(--muted);font-size:12px}.error{color:var(--danger)}@media(max-width:680px){body{padding:7px}.body{grid-template-columns:1fr}.side{border-right:0;border-bottom:1px solid var(--line)}.apps{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:1fr}}
</style></head><body><main class="shell"><header class="head"><div><h1>MCP App 构建器</h1><p class="sub">管理草稿、不可变版本与无需重启的热发布</p></div><span class="badge">热发布</span></header><div class="body"><aside class="side"><button class="new" id="new">＋ 新建 App</button><div class="apps" id="apps"></div></aside><section class="editor"><div class="grid"><div class="field"><label for="appId">App ID</label><input id="appId" placeholder="team-dashboard"></div><div class="field"><label for="title">名称</label><input id="title" placeholder="团队仪表盘"></div><div class="field full"><label for="description">说明</label><input id="description" placeholder="这个 App 解决什么问题"></div><div class="field full"><label for="tools">工具定义（JSON 数组）</label><textarea id="tools"></textarea></div><div class="field full"><label for="html">自包含 UI HTML</label><textarea id="html"></textarea></div></div><div class="actions"><button class="secondary" id="save">保存草稿</button><button class="primary" id="publish">发布并打开</button><button class="secondary" id="rollback">回滚上一版</button><span class="status" id="status">准备就绪</span></div></section></div></main>
<script>
const q=(id)=>document.getElementById(id);let catalog=[],current=null;const starter='<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;padding:24px;color:CanvasText;background:Canvas}button{padding:10px 14px}</style></head><body><h1>我的 MCP App</h1><button id="run">运行工具</button><pre id="out"></pre><script>document.getElementById("run").onclick=async()=>{const r=await window.openai.callTool("app.run",{message:"hello"});document.getElementById("out").textContent=JSON.stringify(r.structuredContent||r,null,2)};<\/script></body></html>';
const starterTools=[{name:'app.run',title:'运行 App',description:'执行 App 操作。',inputSchema:{type:'object',properties:{message:{type:'string'}},additionalProperties:false},readOnlyHint:true,handler:{kind:'echo',text:'已完成'}}];
async function call(name,args){if(!window.openai?.callTool)throw new Error('当前宿主没有 MCP App 工具桥接');const r=await window.openai.callTool(name,args);return r?.structuredContent||r}
function state(message,error=false){q('status').textContent=message;q('status').className=error?'status error':'status'}
function form(spec){q('appId').value=spec?.appId||'';q('title').value=spec?.title||'';q('description').value=spec?.description||'';q('tools').value=JSON.stringify(spec?.tools||starterTools,null,2);q('html').value=spec?.uiHtml||starter}
function spec(){const tools=JSON.parse(q('tools').value);return{appId:q('appId').value,title:q('title').value,description:q('description').value,uiHtml:q('html').value,entryTool:tools[0]?.name||'',tools}}
function render(){q('apps').textContent='';for(const item of catalog){const b=document.createElement('button');b.className='app'+(item.appId===current?' active':'');b.textContent=item.title+' · '+(item.activeRevision?'r'+item.activeRevision:'草稿');b.onclick=()=>load(item.appId);q('apps').appendChild(b)}}
async function refresh(){const data=await call('appBuilder.list',{});catalog=data.apps||[];render()}
async function load(id){try{const data=await call('appBuilder.get',{appId:id});current=id;form(data.draft);render();state(data.activeRevision?'当前 r'+data.activeRevision:'尚未发布')}catch(e){state(e.message||String(e),true)}}
q('new').onclick=()=>{current=null;form(null);render();state('填写新 App')};q('save').onclick=async()=>{try{const data=await call('appBuilder.saveDraft',{spec:spec()});current=data.appId;await refresh();state('草稿已保存')}catch(e){state(e.message||String(e),true)}};q('publish').onclick=async()=>{try{state('正在发布…');await call('appBuilder.saveDraft',{spec:spec()});const data=await call('appBuilder.publish',{appId:q('appId').value});current=data.appId;await refresh();state('已发布 r'+data.revision+'，正在打开');if(window.openai?.sendFollowUpMessage)await window.openai.sendFollowUpMessage({prompt:'$'+data.skillName})}catch(e){state(e.message||String(e),true)}};q('rollback').onclick=async()=>{try{const item=catalog.find(x=>x.appId===current);if(!item||item.activeRevision<2)throw new Error('没有可回滚的上一版');const data=await call('appBuilder.rollback',{appId:current,revision:item.activeRevision-1});await refresh();state('已回滚到 r'+data.revision)}catch(e){state(e.message||String(e),true)}};
form(null);const initial=window.openai?.toolOutput;if(initial?.skillName){state('已发布 r'+initial.revision+'，正在打开');if(window.openai?.sendFollowUpMessage)window.openai.sendFollowUpMessage({prompt:'$'+initial.skillName})}else if(initial?.apps){catalog=initial.apps;render()}else refresh().catch(e=>state(e.message||String(e),true));
</script></body></html>`;

export class McpAppBuilderService extends Service implements McpAppBuilderPort {
  static inject = ["mcpRegistry", "storage", "virtualSkills"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly apps = new Map<string, AppRecord>();
  private readonly releases = new Map<string, Map<number, DynamicMcpAppRelease>>();
  private readonly runtimeRestores: Array<() => boolean> = [];

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "mcpAppBuilder");
    this.initializeStorage();
    this.loadStorage();
    ctx.effect(() => ctx.mcpRegistry.registerServer(this.builderRegistration()));
    ctx.effect(() => ctx.virtualSkills.register({
      name: "build-mcp-app",
      execution: "agent",
      aliases: ["mcp-app-builder", "create-mcp-app", "app-builder"],
      description: "创建、修改、热发布、回滚或删除 HyperNode MCP App。",
      displayName: "MCP App 构建器",
      shortDescription: "通过自然语言创建并热发布 MCP App",
      defaultPrompt: "打开 MCP App 构建器",
      instructions: MCP_APP_AGENT_INSTRUCTIONS,
      resources: { "references/ui-quality.md": UI_QUALITY_REFERENCE },
      run: () => ({
        kind: "mcpAppLaunch",
        server: MCP_APP_BUILDER_SERVER_NAME,
        tool: "appBuilder.list",
        arguments: {},
        resourceUri: MCP_APP_BUILDER_RESOURCE_URI,
        pluginId: "hypernode-control",
        appName: "MCP App 构建器",
        actionName: "打开构建器",
        readOnlyHint: true,
      }),
    }));
    ctx.effect(() => {
      for (const app of this.apps.values()) {
        if (app.activeRevision === null) continue;
        const release = this.releases.get(app.appId)?.get(app.activeRevision);
        if (release) this.runtimeRestores.push(...this.materialize(release));
      }
      return () => {
        for (const restore of this.runtimeRestores.reverse()) restore();
        this.runtimeRestores.length = 0;
      };
    });
  }

  launchRequest(appId: string, connection: AppServerConnection): McpAppLaunchRequest {
    const actor = identity(connection);
    const app = this.ownedApp(appId, actor);
    if (app.activeRevision === null) throw new Error(`MCP App is not published: ${appId}`);
    const release = this.release(appId, app.activeRevision);
    return this.releaseLaunchRequest(release);
  }

  executeAgent(argumentsValue: Record<string, unknown>, principalId: string): { text: string } {
    const action = String(argumentsValue["action"] ?? "publish");
    if (action === "list") {
      return { text: JSON.stringify(this.listForActor(principalId), null, 2) };
    }
    if (action === "get") {
      const app = this.ownedApp(String(argumentsValue["app_id"] ?? ""), principalId);
      return { text: JSON.stringify(this.appDetail(app), null, 2) };
    }
    if (action === "validate" || action === "publish") {
      const source = argumentsValue["spec_json"];
      if (typeof source !== "string" || source.length === 0 || source.length > 650_000) {
        throw new TypeError("spec_json must be a non-empty JSON string under 650 KB");
      }
      const spec = validateDynamicMcpAppSpec(JSON.parse(source));
      if (action === "validate") {
        return { text: JSON.stringify({
          valid: true,
          appId: spec.appId,
          uiDigest: sha256Hex(spec.uiHtml),
          tools: spec.tools.map((tool) => tool.name),
        }) };
      }
      this.saveDraftForActor(spec, principalId);
      const release = this.publishForActor(spec.appId, principalId);
      return { text: [
        JSON.stringify({
          published: true,
          appId: release.appId,
          revision: release.revision,
          uiResourceUri: release.uiResourceUri,
          skillName: `app-${release.appId}`,
        }),
        `Open the finished App with [$app-${release.appId}](/workspace/.codex/skills/app-${release.appId}/SKILL.md).`,
      ].join("\n") };
    }
    if (action === "rollback") {
      const release = this.rollbackForActor(
        String(argumentsValue["app_id"] ?? ""),
        argumentsValue["revision"],
        principalId,
      );
      return { text: JSON.stringify({
        rolledBack: true,
        appId: release.appId,
        revision: release.revision,
        uiResourceUri: release.uiResourceUri,
      }) };
    }
    if (action === "unpublish") {
      return { text: JSON.stringify(this.unpublishForActor(
        String(argumentsValue["app_id"] ?? ""),
        principalId,
      )) };
    }
    if (action === "delete") {
      return { text: JSON.stringify(this.deleteForActor(
        String(argumentsValue["app_id"] ?? ""),
        principalId,
      )) };
    }
    throw new TypeError("action must be list, get, validate, publish, rollback, unpublish, or delete");
  }

  saveDraft(specValue: unknown, connection: AppServerConnection): DynamicMcpAppSpec {
    return this.saveDraftForActor(specValue, identity(connection));
  }

  private saveDraftForActor(specValue: unknown, actor: string): DynamicMcpAppSpec {
    const spec = validateDynamicMcpAppSpec(specValue);
    const existing = this.apps.get(spec.appId);
    if (existing && existing.ownerId !== actor) throw new Error("MCP App belongs to another SSH user");
    const app: AppRecord = existing
      ? { ...existing, draft: spec }
      : { appId: spec.appId, ownerId: actor, activeRevision: null, nextRevision: 1, draft: spec };
    if (this.ctx.storage.sql) this.ctx.storage.sql.exec(`
      INSERT INTO do_mcp_apps (app_id, owner_id, active_revision, next_revision, draft_json, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id) DO UPDATE SET draft_json = excluded.draft_json, updated_at_ms = excluded.updated_at_ms
    `, app.appId, app.ownerId, app.activeRevision, app.nextRevision, JSON.stringify(spec), Date.now());
    this.apps.set(app.appId, app);
    return spec;
  }

  publish(appIdValue: unknown, connection: AppServerConnection): DynamicMcpAppRelease {
    return this.publishForActor(appIdValue, identity(connection));
  }

  private publishForActor(appIdValue: unknown, actor: string): DynamicMcpAppRelease {
    const app = this.ownedApp(String(appIdValue ?? ""), actor);
    const revision = app.nextRevision;
    const digest = sha256Hex(app.draft.uiHtml);
    const release: DynamicMcpAppRelease = {
      appId: app.appId,
      ownerId: actor,
      revision,
      uiDigest: digest,
      uiResourceUri: `ui://hypernode/apps/${app.appId}/sha256-${digest}.html`,
      spec: app.draft,
      publishedAtMs: Date.now(),
    };
    const restores = this.materialize(release);
    try {
      const sql = this.ctx.storage.sql;
      if (sql) this.ctx.storage.transactionSync(() => {
        sql.exec(`
          INSERT INTO do_mcp_app_releases
            (app_id, owner_id, revision, ui_digest, ui_resource_uri, spec_json, published_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, release.appId, release.ownerId, release.revision, release.uiDigest,
        release.uiResourceUri, JSON.stringify(release.spec), release.publishedAtMs);
        sql.exec(`
          UPDATE do_mcp_apps SET active_revision = ?, next_revision = ?, updated_at_ms = ? WHERE app_id = ?
        `, revision, revision + 1, Date.now(), app.appId);
      });
    } catch (error) {
      for (const restore of restores.reverse()) restore();
      throw error;
    }
    app.activeRevision = revision;
    app.nextRevision = revision + 1;
    let versions = this.releases.get(app.appId);
    if (!versions) this.releases.set(app.appId, versions = new Map());
    versions.set(revision, release);
    this.runtimeRestores.push(...restores);
    return release;
  }

  rollback(appIdValue: unknown, revisionValue: unknown, connection: AppServerConnection): DynamicMcpAppRelease {
    return this.rollbackForActor(appIdValue, revisionValue, identity(connection));
  }

  private rollbackForActor(
    appIdValue: unknown,
    revisionValue: unknown,
    actor: string,
  ): DynamicMcpAppRelease {
    const app = this.ownedApp(String(appIdValue ?? ""), actor);
    const revision = Number(revisionValue);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError("revision must be a positive integer");
    const release = this.release(app.appId, revision);
    const restores = this.materialize(release);
    try {
      if (this.ctx.storage.sql) this.ctx.storage.sql.exec(
        "UPDATE do_mcp_apps SET active_revision = ?, updated_at_ms = ? WHERE app_id = ?",
        revision, Date.now(), app.appId,
      );
    } catch (error) {
      for (const restore of restores.reverse()) restore();
      throw error;
    }
    app.activeRevision = revision;
    this.runtimeRestores.push(...restores);
    return release;
  }

  unpublish(appIdValue: unknown, connection: AppServerConnection): Record<string, unknown> {
    return this.unpublishForActor(appIdValue, identity(connection));
  }

  private unpublishForActor(appIdValue: unknown, actor: string): Record<string, unknown> {
    const app = this.ownedApp(String(appIdValue ?? ""), actor);
    const wasPublished = app.activeRevision !== null;
    if (this.ctx.storage.sql) this.ctx.storage.sql.exec(
      "UPDATE do_mcp_apps SET active_revision = NULL, updated_at_ms = ? WHERE app_id = ?",
      Date.now(), app.appId,
    );
    app.activeRevision = null;
    this.removeRuntime(app.appId);
    return {
      unpublished: true,
      appId: app.appId,
      wasPublished,
      draftRetained: true,
      releaseCount: this.releases.get(app.appId)?.size ?? 0,
    };
  }

  deleteApp(appIdValue: unknown, connection: AppServerConnection): Record<string, unknown> {
    return this.deleteForActor(appIdValue, identity(connection));
  }

  private deleteForActor(appIdValue: unknown, actor: string): Record<string, unknown> {
    const app = this.ownedApp(String(appIdValue ?? ""), actor);
    const releaseCount = this.releases.get(app.appId)?.size ?? 0;
    const sql = this.ctx.storage.sql;
    if (sql) this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM do_mcp_app_releases WHERE app_id = ?", app.appId);
      sql.exec("DELETE FROM do_mcp_apps WHERE app_id = ?", app.appId);
    });
    this.removeRuntime(app.appId);
    this.releases.delete(app.appId);
    this.apps.delete(app.appId);
    return {
      deleted: true,
      appId: app.appId,
      deletedReleaseCount: releaseCount,
    };
  }

  private removeRuntime(appId: string): void {
    this.ctx.mcpRegistry.removeServer(`hypernode-app-${appId}`);
    this.ctx.virtualSkills.remove(`app-${appId}`);
  }

  private initializeStorage(): void {
    const sql = this.ctx.storage.sql;
    if (!sql) return;
    sql.exec(`CREATE TABLE IF NOT EXISTS do_mcp_apps (
      app_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      active_revision INTEGER,
      next_revision INTEGER NOT NULL,
      draft_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS do_mcp_app_releases (
      app_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      ui_digest TEXT NOT NULL,
      ui_resource_uri TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      published_at_ms INTEGER NOT NULL,
      PRIMARY KEY (app_id, revision)
    )`);
  }

  private loadStorage(): void {
    const sql = this.ctx.storage.sql;
    if (!sql) return;
    for (const row of sql.exec<AppSqlRow>("SELECT * FROM do_mcp_apps").toArray()) {
      const draft = validateDynamicMcpAppSpec(JSON.parse(row.draft_json));
      this.apps.set(row.app_id, {
        appId: row.app_id,
        ownerId: row.owner_id,
        activeRevision: row.active_revision === null ? null : Number(row.active_revision),
        nextRevision: Number(row.next_revision),
        draft,
      });
    }
    for (const row of sql.exec<ReleaseSqlRow>("SELECT * FROM do_mcp_app_releases").toArray()) {
      const release: DynamicMcpAppRelease = {
        appId: row.app_id,
        ownerId: row.owner_id,
        revision: Number(row.revision),
        uiDigest: row.ui_digest,
        uiResourceUri: row.ui_resource_uri,
        spec: validateDynamicMcpAppSpec(JSON.parse(row.spec_json)),
        publishedAtMs: Number(row.published_at_ms),
      };
      let versions = this.releases.get(release.appId);
      if (!versions) this.releases.set(release.appId, versions = new Map());
      versions.set(release.revision, release);
    }
  }

  private ownedApp(appId: string, actor: string): AppRecord {
    const app = this.apps.get(appId);
    if (!app || app.ownerId !== actor) throw new Error("MCP App not found");
    return app;
  }

  private release(appId: string, revision: number): DynamicMcpAppRelease {
    const release = this.releases.get(appId)?.get(revision);
    if (!release) throw new Error(`MCP App release not found: ${appId}@r${revision}`);
    return release;
  }

  private listFor(connection: AppServerConnection): Record<string, unknown> {
    return this.listForActor(identity(connection));
  }

  private listForActor(actor: string): Record<string, unknown> {
    return {
      apps: [...this.apps.values()].filter((app) => app.ownerId === actor).map((app) => ({
        appId: app.appId,
        title: app.draft.title,
        description: app.draft.description,
        activeRevision: app.activeRevision,
        nextRevision: app.nextRevision,
      })).sort((left, right) => left.appId.localeCompare(right.appId)),
    };
  }

  private getFor(appId: unknown, connection: AppServerConnection): Record<string, unknown> {
    const app = this.ownedApp(String(appId ?? ""), identity(connection));
    return this.appDetail(app);
  }

  private appDetail(app: AppRecord): Record<string, unknown> {
    return {
      appId: app.appId,
      activeRevision: app.activeRevision,
      nextRevision: app.nextRevision,
      draft: app.draft,
      releases: [...(this.releases.get(app.appId)?.values() ?? [])].map((release) => ({
        revision: release.revision,
        uiResourceUri: release.uiResourceUri,
        uiDigest: release.uiDigest,
        publishedAtMs: release.publishedAtMs,
      })).sort((left, right) => right.revision - left.revision),
    };
  }

  private releaseLaunchRequest(release: DynamicMcpAppRelease): McpAppLaunchRequest {
    const entry = release.spec.tools.find((tool) => tool.name === release.spec.entryTool)!;
    return {
      kind: "mcpAppLaunch",
      server: `hypernode-app-${release.appId}`,
      tool: entry.name,
      arguments: {},
      resourceUri: release.uiResourceUri,
      pluginId: `hypernode-dynamic-${release.appId}`,
      appName: release.spec.title,
      actionName: `Open ${release.spec.title}`,
      readOnlyHint: entry.readOnlyHint !== false,
    };
  }

  private materialize(release: DynamicMcpAppRelease): Array<() => boolean> {
    const serverRestore = this.ctx.mcpRegistry.replaceServer(this.releaseRegistration(release));
    try {
      const skillRestore = this.ctx.virtualSkills.replace({
        name: `app-${release.appId}`,
        aliases: [release.appId],
        description: release.spec.skillDescription ?? `Open ${release.spec.title}.`,
        displayName: release.spec.title,
        shortDescription: release.spec.description,
        defaultPrompt: `Open ${release.spec.title}`,
        visible: (connection) => connection.identity?.id === release.ownerId,
        run: (_input, invocation) => this.launchRequest(release.appId, invocation.connection),
      });
      return [serverRestore, skillRestore];
    } catch (error) {
      serverRestore();
      throw error;
    }
  }

  private releaseRegistration(release: DynamicMcpAppRelease): McpServerRegistration {
    return {
      name: `hypernode-app-${release.appId}`,
      pluginId: `hypernode-dynamic-${release.appId}`,
      title: release.spec.title,
      description: release.spec.description,
      version: `${release.revision}.0.0`,
      visible: (connection) => connection.identity?.id === release.ownerId,
      tools: release.spec.tools.map((spec): McpToolRegistration => {
        const javascript = spec.handler.kind === "javascript"
          ? compileJavascriptHandler(spec.handler.source)
          : null;
        return {
          name: spec.name,
          title: spec.title,
          description: spec.description,
          inputSchema: spec.inputSchema,
          ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
          annotations: { readOnlyHint: spec.readOnlyHint !== false, openWorldHint: false },
          _meta: toolMeta(release.uiResourceUri, spec.name === release.spec.entryTool),
          call: (argumentsValue, context) => {
            if (spec.handler.kind === "javascript") {
              if (!javascript) throw new Error("JavaScript handler was not compiled");
              return javascriptToolResult(javascript(argumentsValue, {
                appId: release.appId,
                revision: release.revision,
                server: context.server,
                tool: context.tool,
                threadId: context.threadId,
                principalId: context.connection.identity?.id ?? null,
              }));
            }
            if (spec.handler.kind === "echo") {
              return toolResult(
                { arguments: argumentsValue, appId: release.appId, revision: release.revision },
                spec.handler.text,
              );
            }
            return toolResult(spec.handler.structuredContent ?? {}, spec.handler.text);
          },
        };
      }),
      resources: [{
        uri: release.uiResourceUri,
        name: `${release.appId}-ui-r${release.revision}`,
        title: release.spec.title,
        description: release.spec.description,
        mimeType: "text/html;profile=mcp-app",
        read: () => release.spec.uiHtml,
      }],
    };
  }

  private builderRegistration(): McpServerRegistration {
    const meta = toolMeta(MCP_APP_BUILDER_RESOURCE_URI, true);
    return {
      name: MCP_APP_BUILDER_SERVER_NAME,
      pluginId: "hypernode-control",
      title: "MCP App 构建器",
      description: "在当前 HyperNode 上创建并热发布带版本的 MCP App。",
      version: "1.0.0",
      tools: [
        {
          name: "appBuilder.list", title: "查看 MCP App", description: "列出你的 MCP App 草稿与当前发布版本。",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, openWorldHint: false }, _meta: meta,
          call: (_args, context) => toolResult(this.listFor(context.connection)),
        },
        {
          name: "appBuilder.get", title: "读取 MCP App", description: "读取一个 MCP App 草稿。",
          inputSchema: { type: "object", properties: { appId: { type: "string" } }, required: ["appId"], additionalProperties: false },
          annotations: { readOnlyHint: true, openWorldHint: false }, _meta: meta,
          call: (args, context) => toolResult(this.getFor(isRecord(args) ? args["appId"] : null, context.connection)),
        },
        {
          name: "appBuilder.validate", title: "校验 MCP App", description: "校验 MCP App 定义，但不保存。",
          inputSchema: { type: "object", properties: { spec: { type: "object" } }, required: ["spec"], additionalProperties: false },
          annotations: { readOnlyHint: true, openWorldHint: false }, _meta: meta,
          call: (args, context) => {
            identity(context.connection);
            const spec = validateDynamicMcpAppSpec(isRecord(args) ? args["spec"] : null);
            return toolResult({
              appId: spec.appId,
              valid: true,
              uiDigest: sha256Hex(spec.uiHtml),
              toolNames: spec.tools.map((tool) => tool.name),
            });
          },
        },
        {
          name: "appBuilder.saveDraft", title: "保存 MCP App 草稿", description: "校验并保存 MCP App 草稿。",
          inputSchema: { type: "object", properties: { spec: { type: "object" } }, required: ["spec"], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: meta,
          call: (args, context) => {
            const spec = this.saveDraft(isRecord(args) ? args["spec"] : null, context.connection);
            return toolResult({ appId: spec.appId, valid: true });
          },
        },
        {
          name: "appBuilder.publish", title: "发布 MCP App", description: "创建不可变版本，并在无需重启 HyperNode 的情况下原子启用。",
          inputSchema: { type: "object", properties: { appId: { type: "string" } }, required: ["appId"], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: meta,
          call: (args, context) => {
            const release = this.publish(isRecord(args) ? args["appId"] : null, context.connection);
            return toolResult({
              appId: release.appId, revision: release.revision, uiResourceUri: release.uiResourceUri,
              skillName: `app-${release.appId}`, server: `hypernode-app-${release.appId}`,
            }, `${release.spec.title} published as r${release.revision}`);
          },
        },
        {
          name: "appBuilder.rollback", title: "回滚 MCP App", description: "原子切换到较早的不可变版本。",
          inputSchema: { type: "object", properties: { appId: { type: "string" }, revision: { type: "integer", minimum: 1 } }, required: ["appId", "revision"], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, _meta: meta,
          call: (args, context) => {
            const release = this.rollback(
              isRecord(args) ? args["appId"] : null,
              isRecord(args) ? args["revision"] : null,
              context.connection,
            );
            return toolResult({ appId: release.appId, revision: release.revision, uiResourceUri: release.uiResourceUri });
          },
        },
        {
          name: "appBuilder.unpublish", title: "取消发布 MCP App", description: "移除在线 MCP 服务与入口，但保留草稿和不可变版本。",
          inputSchema: { type: "object", properties: { appId: { type: "string" } }, required: ["appId"], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, _meta: meta,
          call: (args, context) => toolResult(this.unpublish(
            isRecord(args) ? args["appId"] : null,
            context.connection,
          )),
        },
        {
          name: "appBuilder.delete", title: "删除 MCP App", description: "永久删除 MCP App、草稿及全部不可变版本，不再额外确认。",
          inputSchema: { type: "object", properties: { appId: { type: "string" } }, required: ["appId"], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, _meta: meta,
          call: (args, context) => toolResult(this.deleteApp(
            isRecord(args) ? args["appId"] : null,
            context.connection,
          )),
        },
      ],
      resources: [{
        uri: MCP_APP_BUILDER_RESOURCE_URI,
        name: "hypernode-app-builder-ui",
        title: "MCP App 构建器",
        description: "创建并热发布 MCP App。",
        mimeType: "text/html;profile=mcp-app",
        read: () => MCP_APP_BUILDER_HTML,
      }],
    };
  }
}
