import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  McpServerRegistration,
  McpToolCallResult,
} from "../types/mcp.ts";
import type { ThreadPrivacyPort } from "../types/thread-privacy.ts";
import { canonicalThreadTitle } from "./thread-identity.ts";

export const THREAD_PRIVACY_SERVER_NAME = "hypernode-thread-privacy";
export const THREAD_PRIVACY_RESOURCE_URI = "ui://hypernode/thread-privacy.html";

type Dependencies =
  | "appServer"
  | "mcpRegistry"
  | "threadManager"
  | "transparentSubscription";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredThreadId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw rpcError(-32602, "threadId must be a non-empty string");
  }
  return value;
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function textResult(structuredContent: unknown, text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function toolMeta(entrypoint = false): Record<string, unknown> {
  return {
    ui: { resourceUri: THREAD_PRIVACY_RESOURCE_URI, visibility: ["app", "model"] },
    "ui/resourceUri": THREAD_PRIVACY_RESOURCE_URI,
    "openai/outputTemplate": THREAD_PRIVACY_RESOURCE_URI,
    ...(entrypoint
      ? { "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] } }
      : {}),
  };
}

function messageThreadId(message: JsonRpcRequest | JsonRpcResponse): string | null {
  const params = isRecord(message.params) ? message.params : null;
  if (typeof params?.["threadId"] === "string") return params["threadId"];
  const paramsThread = isRecord(params?.["thread"]) ? params?.["thread"] : null;
  if (typeof paramsThread?.["id"] === "string") return paramsThread["id"];
  const wire = message as Record<string, unknown>;
  const result = isRecord(wire["result"]) ? wire["result"] : null;
  const resultThread = isRecord(result?.["thread"]) ? result?.["thread"] : null;
  return typeof resultThread?.["id"] === "string" ? resultThread["id"] : null;
}

const SKILL_TITLES: Record<string, string> = {
  hypernode: "HyperNode",
  "set-visibility": "设置可见性",
  "private-thread": "设置可见性",
  "thread-privacy": "设置可见性",
};

export function threadPrivacyDisplayName(value: unknown, preview: unknown = ""): string {
  let name = canonicalThreadTitle(value, preview);
  name = name.replace(
    /\[\$([^\]]+)\]\([^)]*\/SKILL\.md\)/giu,
    (_full, skillId: string) => SKILL_TITLES[skillId.toLowerCase()] ??
      skillId.replace(/[-_]+/g, " "),
  );
  name = name.replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1").replace(/\s+/g, " ").trim();
  return name || "未命名会话";
}

export const THREAD_PRIVACY_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      font-size: var(--font-size-base,14px);
      --app-background: var(--background,Canvas);
      --app-foreground: var(--foreground,CanvasText);
      --app-muted-foreground: var(--muted-foreground,GrayText);
      --app-border: var(--border,color-mix(in srgb,CanvasText 16%,transparent));
      --app-input: var(--input,var(--app-border));
      --app-primary: var(--primary,AccentColor);
      --app-primary-foreground: var(--primary-foreground,AccentColorText);
      --app-destructive: var(--destructive,CanvasText);
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; color: var(--app-foreground); background: transparent; }
    button,input,select { font: inherit; }
    strong,h1 { font-weight: 500; }
    .visibility-app { width: 100%; }
    .visibility-heading { margin-bottom: 16px; }
    h1 { margin: 0; font: inherit; font-weight: 500; }
    .text-small { font-size: max(11px,.86em); }
    .text-muted { color: var(--app-muted-foreground); }
    .visibility-subtitle { margin: 4px 0 0; }
    .form-label { display: block; margin: 0 0 6px; color: var(--app-muted-foreground); font-weight: 500; }
    .form-select { width: 100%; min-height: 40px; padding: 7px 10px; border: 1px solid var(--app-input); border-radius: 8px; color: var(--app-foreground); background: var(--app-background); font-size: max(16px,1em); }
    fieldset { min-width: 0; margin: 16px 0 0; padding: 0; border: 0; }
    .viz-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; }
    .form-check { display: inline-flex; min-height: 40px; align-items: center; gap: 8px; cursor: pointer; }
    .form-check-input { width: 16px; height: 16px; margin: 0; accent-color: var(--app-primary); }
    .form-check-label { font-weight: 400; }
    .visibility-action { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-top: 16px; }
    .visibility-status { margin: 0; color: var(--app-muted-foreground); }
    .visibility-status.error { color: var(--app-destructive); }
    .btn { min-height: 40px; padding: 7px 14px; border: 1px solid var(--app-border); border-radius: 8px; color: var(--app-foreground); background: var(--app-background); cursor: pointer; }
    .btn-primary { border-color: var(--app-primary); color: var(--app-primary-foreground); background: var(--app-primary); }
    .btn:disabled { opacity: .5; cursor: default; }
    .visibility-note { margin: 14px 0 0; padding-top: 12px; border-top: 1px solid var(--app-border); }
    @media (pointer: coarse) { .btn,.form-check,.form-select { min-height: 44px; } }
    @media (max-width: 360px) { body { padding: 8px; } .visibility-action .btn { width: 100%; } }
  </style>
</head>
<body>
  <main class="visibility-app">
    <header class="visibility-heading">
      <h1>设置可见性</h1>
      <p class="visibility-subtitle text-small text-muted">管理你创建的会话在当前 HyperNode 上的访问范围</p>
    </header>
    <div>
      <label class="form-label" for="threads">会话</label>
      <select id="threads" class="form-select" aria-label="选择会话"></select>
    </div>
    <fieldset>
      <legend class="form-label">谁可以查看</legend>
      <div class="viz-controls">
        <label class="form-check">
          <input class="form-check-input" type="radio" name="visibility" value="private">
          <span class="form-check-label">仅自己</span>
        </label>
        <label class="form-check">
          <input class="form-check-input" type="radio" name="visibility" value="nodeShared">
          <span class="form-check-label">本节点用户</span>
        </label>
      </div>
    </fieldset>
    <div class="visibility-action">
      <p id="status" class="visibility-status text-small" role="status" aria-live="polite"><span id="status-text">正在读取可管理的会话…</span></p>
      <button id="apply" class="btn btn-primary" type="button" disabled>保存更改</button>
    </div>
    <p class="visibility-note text-small text-muted"><strong>备注：</strong>节点公开仅限本节点已登录用户，不代表互联网公开。</p>
  </main>
  <script>
    const select = document.getElementById("threads");
    const button = document.getElementById("apply");
    const status = document.getElementById("status");
    const statusText = document.getElementById("status-text");
    const radios = Array.from(document.querySelectorAll('input[name="visibility"]'));
    let threads = [];
    let desiredVisibility = null;
    function selected() { return threads.find((item) => item.id === select.value); }
    function show(message, kind) {
      statusText.textContent = message;
      status.className = "visibility-status text-small" + (kind === "error" ? " error" : "");
      status.setAttribute("role", kind === "error" ? "alert" : "status");
    }
    function setDesired(value) {
      desiredVisibility = value;
      for (const radio of radios) {
        radio.checked = radio.value === value;
      }
      const item = selected();
      button.disabled = !item || item.visibility === desiredVisibility;
      button.textContent = "保存更改";
    }
    function updateSelection() {
      const item = selected();
      setDesired(item ? item.visibility : null);
      for (const radio of radios) radio.disabled = !item;
      if (item && item.visibility === "private") show("当前仅你可见", "private");
      else if (item) show("当前对本节点已登录用户可见", "shared");
    }
    function render(data) {
      threads = Array.isArray(data && data.threads) ? data.threads : [];
      select.textContent = "";
      for (const item of threads) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.name;
        select.appendChild(option);
      }
      if (data && data.preferredThreadId && threads.some((item) => item.id === data.preferredThreadId)) select.value = data.preferredThreadId;
      if (threads.length === 0) {
        const option = document.createElement("option"); option.textContent = "没有可管理的会话"; select.appendChild(option);
        show("系统会话和其他用户创建的会话不能由你修改可见性。", "");
      }
      updateSelection();
    }
    async function call(name, args) {
      if (!window.openai || typeof window.openai.callTool !== "function") throw new Error("当前宿主没有提供 MCP App 工具桥接");
      const response = await window.openai.callTool(name, args);
      return response && response.structuredContent ? response.structuredContent : response;
    }
    select.addEventListener("change", updateSelection);
    for (const radio of radios) radio.addEventListener("change", () => setDesired(radio.value));
    button.addEventListener("click", async () => {
      const item = selected(); if (!item) return;
      const makingPrivate = desiredVisibility === "private";
      if (desiredVisibility === item.visibility) return;
      button.disabled = true;
      show(makingPrivate ? "正在设为仅自己…" : "正在向本节点公开…", "");
      try {
        const result = await call(
          makingPrivate ? "threadPrivacy.setPrivate" : "threadPrivacy.setShared",
          { threadId: item.id },
        );
        item.visibility = result.visibility;
        render({ threads: threads, preferredThreadId: item.id });
        show(
          makingPrivate
            ? "已保存：现在仅你可见"
            : "已保存：本节点已登录用户现在可以查看",
          makingPrivate ? "private" : "shared",
        );
      } catch (error) {
        show(error && error.message ? error.message : String(error), "error");
        setDesired(desiredVisibility);
      }
    });
    const initial = window.openai && window.openai.toolOutput;
    if (initial && typeof initial === "object") render(initial);
    else show("没有收到会话列表，请重新打开此 App。", "error");
  </script>
</body>
</html>`;

export class ThreadPrivacyService extends Service implements ThreadPrivacyPort {
  static inject = [
    "appServer",
    "mcpRegistry",
    "threadManager",
    "transparentSubscription",
  ] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "threadPrivacy");
    ctx.effect(() => ctx.appServer.intercept((message, connection) => (
      this.guardInbound(message, connection)
    )));
    ctx.effect(() => ctx.appServer.projectOutbound((message, connection) => (
      this.guardOutbound(message, connection)
    )));
    ctx.effect(() => ctx.mcpRegistry.registerServer(this.registration()));
  }

  private actor(connection: AppServerConnection): string {
    const actor = connection.identity?.id;
    if (typeof actor !== "string" || actor.length === 0) {
      throw rpcError(-32001, "an authenticated SSH identity is required");
    }
    return actor;
  }

  private guardInbound(
    message: JsonRpcRequest | null,
    connection: AppServerConnection,
  ): false {
    if (!message) return false;
    const threadId = messageThreadId(message);
    if (!threadId || !this.ctx.threadManager.find(threadId)) return false;
    if (!this.ctx.threadManager.visibleTo(threadId, connection.identity?.id ?? null)) {
      throw rpcError(-32004, "thread not found or not accessible");
    }
    return false;
  }

  private guardOutbound(
    message: JsonRpcResponse,
    connection: AppServerConnection,
  ): JsonRpcResponse | null {
    // A client that previously knew a shared thread needs this tombstone-like
    // notification so it removes the item immediately after privatization.
    // Strip the internal marker before it crosses the wire. Ordinary future
    // archive notifications for a private thread remain hidden.
    const params = isRecord(message.params) ? message.params : null;
    if (message.method === "thread/archived" && params?.["hypernodePrivacyRevocation"] === true) {
      const { hypernodePrivacyRevocation: _marker, ...publicParams } = params;
      return { ...message, params: publicParams };
    }
    const threadId = messageThreadId(message);
    if (!threadId || !this.ctx.threadManager.find(threadId)) return message;
    return this.ctx.threadManager.visibleTo(threadId, connection.identity?.id ?? null)
      ? message
      : null;
  }

  listFor(
    connection: AppServerConnection,
    preferredThreadId: string | null = null,
  ): Record<string, unknown> {
    const actor = this.actor(connection);
    const candidates = this.ctx.threadManager.list(
      { archived: false, sortKey: "recency_at", sortDirection: "desc" },
      actor,
    ).filter((thread) => (
      !this.ctx.threadManager.isSystem(thread.id) &&
      thread["ephemeral"] !== true &&
      this.ctx.threadManager.ownerOf(thread.id) === actor
    )).slice(0, 100).map((thread) => ({
      id: thread.id,
      name: threadPrivacyDisplayName(thread["name"], thread["preview"]),
      preview: String(thread["preview"] ?? "").slice(0, 160),
      visibility: this.ctx.threadManager.metadataFor(thread.id)?.visibility ?? "private",
      updatedAt: thread["updatedAt"] ?? null,
    }));
    const preferred = candidates.some((thread) => thread.id === preferredThreadId)
      ? preferredThreadId
      : candidates[0]?.id ?? null;
    return { threads: candidates, preferredThreadId: preferred };
  }

  makePrivate(threadIdValue: string, connection: AppServerConnection): Record<string, unknown> {
    const threadId = requiredThreadId(threadIdValue);
    const actor = this.actor(connection);
    const thread = this.ctx.threadManager.find(threadId);
    const metadata = this.ctx.threadManager.metadataFor(threadId);
    if (!thread || !metadata || metadata.ownerPrincipalId !== actor) {
      throw rpcError(-32004, "thread not found or not accessible");
    }
    if (thread["ephemeral"] === true) throw rpcError(-32602, "ephemeral threads cannot be private");
    if (this.ctx.threadManager.isSystem(threadId)) {
      throw rpcError(-32602, "system threads cannot be private");
    }

    const transitioned = metadata.visibility !== "private";
    this.ctx.threadManager.setVisibility(threadId, "private");
    const notified = new Set<AppServerConnection>();
    if (transitioned) {
      const revoked = this.ctx.transparentSubscription.revokeWhere(
        threadId,
        (candidate) => candidate.identity?.id !== actor,
      );
      for (const candidate of revoked) notified.add(candidate);
      for (const candidate of this.ctx.appServer.connections) {
        if (!candidate.initialized || candidate.identity?.id === actor) continue;
        candidate.threadCatalogStatuses?.delete(threadId);
        candidate.threadPresentationNames?.delete(threadId);
        if (candidate.activeThreadId === threadId) candidate.activeThreadId = null;
        notified.add(candidate);
      }
      for (const candidate of notified) {
        this.ctx.appServer.send(candidate, {
          method: "thread/archived",
          params: { threadId, hypernodePrivacyRevocation: true },
        });
      }
    }
    return {
      threadId,
      name: threadPrivacyDisplayName(thread.name, thread.preview),
      visibility: "private",
      ownerPrincipalId: actor,
      revokedConnections: notified.size,
    };
  }

  makeShared(threadIdValue: string, connection: AppServerConnection): Record<string, unknown> {
    const threadId = requiredThreadId(threadIdValue);
    const actor = this.actor(connection);
    const thread = this.ctx.threadManager.find(threadId);
    const metadata = this.ctx.threadManager.metadataFor(threadId);
    if (!thread || !metadata || metadata.ownerPrincipalId !== actor) {
      throw rpcError(-32004, "thread not found or not accessible");
    }
    if (thread["ephemeral"] === true) {
      throw rpcError(-32602, "ephemeral thread visibility cannot be changed");
    }
    if (this.ctx.threadManager.isSystem(threadId)) {
      throw rpcError(-32602, "system thread visibility cannot be changed");
    }

    const transitioned = metadata.visibility !== "nodeShared";
    this.ctx.threadManager.setVisibility(threadId, "nodeShared");
    const notified = new Set<AppServerConnection>();
    if (transitioned) {
      for (const candidate of this.ctx.appServer.connections) {
        if (!candidate.initialized || candidate.identity?.id === actor) continue;
        candidate.threadCatalogStatuses?.delete(threadId);
        candidate.threadPresentationNames?.delete(threadId);
        notified.add(candidate);
      }
      for (const candidate of notified) {
        this.ctx.appServer.send(candidate, {
          method: "thread/unarchived",
          params: { threadId },
        });
      }
    }
    return {
      threadId,
      name: threadPrivacyDisplayName(thread.name, thread.preview),
      visibility: "nodeShared",
      ownerPrincipalId: actor,
      notifiedConnections: notified.size,
    };
  }

  registration(): McpServerRegistration {
    return {
      name: THREAD_PRIVACY_SERVER_NAME,
      pluginId: "hypernode-control",
      title: "设置可见性",
      description: "Owner-authorized controls for private and node-shared HyperNode conversations.",
      version: "1.3.0",
      tools: [
        {
          name: "threadPrivacy.list",
          title: "Choose a conversation",
          description: "List conversations owned by the current SSH user and their privacy state.",
          inputSchema: {
            type: "object",
            properties: { preferredThreadId: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {
              threads: { type: "array", items: { type: "object" } },
              preferredThreadId: { type: ["string", "null"] },
            },
            required: ["threads", "preferredThreadId"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
          _meta: toolMeta(true),
          call: (argumentsValue, context) => {
            const preferred = isRecord(argumentsValue) &&
              typeof argumentsValue["preferredThreadId"] === "string"
              ? argumentsValue["preferredThreadId"]
              : context.threadId;
            const structuredContent = this.listFor(context.connection, preferred);
            return textResult(structuredContent, "Choose a conversation and manage its visibility.");
          },
        },
        {
          name: "threadPrivacy.setPrivate",
          title: "Make conversation private",
          description: "Restrict an owned conversation to its SSH owner.",
          inputSchema: {
            type: "object",
            properties: { threadId: { type: "string" } },
            required: ["threadId"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {
              threadId: { type: "string" },
              name: { type: "string" },
              visibility: { type: "string", enum: ["private"] },
              ownerPrincipalId: { type: "string" },
              revokedConnections: { type: "number" },
            },
            required: ["threadId", "name", "visibility", "ownerPrincipalId", "revokedConnections"],
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: toolMeta(),
          call: (argumentsValue, context) => {
            const threadId = isRecord(argumentsValue) ? argumentsValue["threadId"] : undefined;
            const structuredContent = this.makePrivate(requiredThreadId(threadId), context.connection);
            return textResult(structuredContent, `Conversation ${structuredContent["name"]} is now private.`);
          },
        },
        {
          name: "threadPrivacy.setShared",
          title: "Share conversation with this node",
          description: "Make an owned conversation visible to every authenticated SSH user on this HyperNode.",
          inputSchema: {
            type: "object",
            properties: { threadId: { type: "string" } },
            required: ["threadId"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {
              threadId: { type: "string" },
              name: { type: "string" },
              visibility: { type: "string", enum: ["nodeShared"] },
              ownerPrincipalId: { type: "string" },
              notifiedConnections: { type: "number" },
            },
            required: ["threadId", "name", "visibility", "ownerPrincipalId", "notifiedConnections"],
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: toolMeta(),
          call: (argumentsValue, context) => {
            const threadId = isRecord(argumentsValue) ? argumentsValue["threadId"] : undefined;
            const structuredContent = this.makeShared(requiredThreadId(threadId), context.connection);
            return textResult(
              structuredContent,
              `Conversation ${structuredContent["name"]} is now shared with this HyperNode.`,
            );
          },
        },
      ],
      resources: [{
        uri: THREAD_PRIVACY_RESOURCE_URI,
        name: "hypernode-thread-privacy-ui",
        title: "设置可见性",
        description: "Switch an owned conversation between private and node-shared visibility.",
        mimeType: "text/html;profile=mcp-app",
        read: () => THREAD_PRIVACY_HTML,
      }],
    };
  }
}
