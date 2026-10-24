import type { ComposerContextReference, SubmitIntent } from "@opencraft/composer-core";
import type { AppServerMethod, AppServerMethodParams, AppServerMethodResult } from "@opencraft/appserver-protocol";
import { record, type McpAppPort, type McpAppWidgetStateStore } from "./contract";
import { MCP_APP_RESOURCE_META } from "@opencraft/appserver-protocol/mcp-apps";

interface OwnerOptions {
  readonly key: string;
  readonly widgetStateStore?: { readonly scope: string; readonly entries: McpAppWidgetStateStore };
  readonly threadId: string;
  readonly assertCurrent: () => void;
  readonly request: <M extends AppServerMethod>(method: M, params: AppServerMethodParams<M>) => Promise<AppServerMethodResult<M>>;
  readonly sendMessage: (text: string) => Promise<void>;
  readonly openLink: (url: string) => void;
}
/** Ephemeral view state, never a second conversation history or execution authority. */
export function createMcpAppOwner(options: OwnerOptions): McpAppPort & { augment(intent: SubmitIntent): SubmitIntent } {
  const context = new Map<string, string>();
  const widgetStates: McpAppWidgetStateStore = options.widgetStateStore?.entries ?? new Map();
  let catalogReadAt = 0;
  let catalog: Promise<Record<string, Record<string, unknown>>> | null = null;
  let historyHydration: Promise<unknown> | null = null;
  const assertCurrent = options.assertCurrent;
  return {
    key: options.key, assertCurrent,
    widgetState(viewId, identity) {
      assertCurrent();
      const key = JSON.stringify([options.widgetStateStore?.scope ?? options.key, viewId,
        identity.server, identity.uri, identity.callId]);
      let state = widgetStates.get(key);
      if (!state) { state = { current: null }; widgetStates.set(key, state); }
      return state;
    },
    async readResource(server, uri, callId) {
      assertCurrent();
      const read = () => options.request("mcpServer/resource/read", { threadId: options.threadId, server, uri, originCallId: callId });
      let result;
      try { result = await read(); }
      catch (error) {
        assertCurrent();
        if (!server.startsWith("opencraft-app-") || !uri.startsWith("ui://opencraft/apps/")) throw error;
        // A restored card may precede this connection's canonical history. Share
        // one read-only hydration; only gateway-observed output can grant access.
        historyHydration ??= options.request("thread/read", { threadId: options.threadId, includeTurns: true }).catch(error => {
          historyHydration = null;
          throw error;
        });
        try { await historyHydration; } catch { throw error; }
        assertCurrent(); result = await read();
      }
      assertCurrent(); catalog = null; return result;
    },
    async listTools(server, resourceUri) {
      assertCurrent();
      if (Date.now() - catalogReadAt > 10000) catalog = null;
      if (!catalog) {
        catalogReadAt = Date.now();
        catalog = (async () => {
        const servers: Record<string, Record<string, unknown>> = Object.create(null);
        let cursor: string | null = null;
        const seen = new Set<string>();
        for (let page = 0; page < 20; page++) {
          const result: AppServerMethodResult<"mcpServerStatus/list"> = await options.request("mcpServerStatus/list", { threadId: options.threadId, cursor, limit: 100, detail: "toolsAndAuthOnly" });
          assertCurrent();
          for (const entry of result.data) {
            const tools = record(entry.tools);
            servers[entry.name] = tools;
            for (const resource of entry.resources ?? []) {
              if (typeof record(resource).uri === "string") servers[JSON.stringify([entry.name, record(resource).uri])] = tools;
            }
          }
          const nextCursor = result.nextCursor;
          if (!nextCursor) return servers;
          if (seen.has(nextCursor)) throw new Error("Invalid MCP catalog cursor");
          cursor = nextCursor; seen.add(nextCursor);
        }
        throw new Error("MCP catalog exceeds its page limit");
      })().catch(error => { catalog = null; throw error; });
      }
      const entries = await catalog;
      const tools = (resourceUri ? entries[JSON.stringify([server, resourceUri])] : undefined) ?? entries[server];
      assertCurrent();
      if (!tools) throw new Error("MCP server is not available");
      return Object.fromEntries(Object.entries(tools).filter(([, value]) => {
        const visibility = record(record(record(value)._meta).ui).visibility;
        return !(Array.isArray(visibility) && visibility.includes("model") && !visibility.includes("app"));
      }));
    },
    async callTool(server, tool, args, resourceUri) {
      assertCurrent();
      const result = await options.request("mcpServer/tool/call", { threadId: options.threadId, server, tool, arguments: JSON.parse(JSON.stringify(args)),
        ...(resourceUri && server.startsWith("opencraft-app-") ? { _meta: { [MCP_APP_RESOURCE_META]: resourceUri } } : {}),
      });
      assertCurrent(); return result;
    },
    sendMessage: async text => { assertCurrent(); await options.sendMessage(text); assertCurrent(); },
    updateContext(id, value) {
      assertCurrent();
      if (value === null) { context.delete(id); return; }
      const total = [...context].reduce((sum, [key, text]) => sum + (key === id ? 0 : text.length), value.length);
      if ((!context.has(id) && context.size >= 16) || total > 65536) throw new Error("App context budget exceeded");
      context.set(id, value);
    },
    openLink(url) { assertCurrent(); options.openLink(url); },
    augment(intent) {
      if (context.size === 0) return intent;
      assertCurrent();
      const refs: ComposerContextReference[] = [...context].map(([id, value]) => ({ id: `mcp-app:${id}`, kind: "mcp", title: "MCP App context", uri: null, visible: true, metadata: { additionalContextKind: "untrusted", value } }));
      return { ...intent, context: [...intent.context, ...refs] };
    },
  };
}
