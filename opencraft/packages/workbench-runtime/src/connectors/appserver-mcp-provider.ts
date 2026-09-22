import type { AppServerClient } from "@opencraft/appserver-client";
import type { ListMcpServerStatusParams, McpServerToolCallParams } from "@opencraft/appserver-protocol/generated/v2";
import type { ConnectorProvider, ConnectorTool } from "./contract";
import { ConnectorError, objectInput } from "./lifetime";

/** Borrow a Host-owned MCP client. No new transport, token store or remote-config writes. */
export function createAppServerMcpConnectorProvider(options: {
  readonly id: string;
  readonly title: string;
  readonly server: string;
  readonly resolveClient: (hostId: string) => Promise<AppServerClient>;
} & ({ readonly public: true; readonly authenticationProviderId?: never } | { readonly authenticationProviderId: string; readonly public?: never })): ConnectorProvider {
  if (options.public !== true && !options.authenticationProviderId?.trim()) throw new ConnectorError("invalid-input");
  return { id: options.id, title: options.title,
    ...(options.authenticationProviderId ? { authenticationProviderId: options.authenticationProviderId } : {}),
    contributions: [{ id: "mcp-tools", kind: "tools", async prepare({ target, signal }) {
      const client = await options.resolveClient(target.hostId);
      if (client.hostId !== target.hostId || client.status.state !== "open" || signal.aborted) throw new ConnectorError("unavailable");
      const generation = client.connectionGeneration;
      let disposed = false;
      const current = () => !disposed && client.status.state === "open" && client.connectionGeneration === generation;
      async function status(threadId: string | null, signal: AbortSignal): Promise<{ authStatus: string; tools: ConnectorTool[] }> {
        const seen = new Set<string>(); let cursor: string | null = null;
        for (let page = 0; page < 100; page++) {
          const params: ListMcpServerStatusParams = { threadId, cursor, limit: 100, detail: "toolsAndAuthOnly" };
          const result = objectInput(await client.requestRaw("mcpServerStatus/list", params, { signal }));
          if (!Array.isArray(result.data)) throw new ConnectorError("invalid-input");
          for (const row of result.data) {
            const server = objectInput(row);
            if (server.name !== options.server) continue;
            if (typeof server.authStatus !== "string" || !["unknown", "unsupported", "notLoggedIn", "bearerToken", "oAuth"].includes(server.authStatus)) throw new ConnectorError("invalid-input");
            const tools = Object.values(objectInput(server.tools)).flatMap(value => {
              const tool = objectInput(value);
              if (typeof tool.name !== "string" || !tool.name || (tool.description !== undefined && typeof tool.description !== "string")) throw new ConnectorError("invalid-input");
              const annotations = tool.annotations ? objectInput(tool.annotations) : {};
              return [{ name: tool.name, description: typeof tool.description === "string" ? tool.description : tool.name, readOnly: annotations.readOnlyHint === true, inputSchema: objectInput(tool.inputSchema) }];
            }).sort((a, b) => a.name.localeCompare(b.name));
            return { authStatus: server.authStatus, tools };
          }
          if (result.nextCursor !== null && typeof result.nextCursor !== "string") throw new ConnectorError("invalid-input");
          cursor = result.nextCursor;
          if (!cursor || seen.has(cursor)) break;
          seen.add(cursor);
        }
        throw new ConnectorError("unavailable");
      }
      const allowed = (server: { authStatus: string }) => server.authStatus !== "notLoggedIn" && server.authStatus !== "unknown";
      const initial = await status(null, signal);
      if (!allowed(initial) || !current()) throw new ConnectorError("authorization-required");
      const inventory = initial.tools;
      if (inventory.length === 0) throw new ConnectorError("unavailable");
      // A changed schema requires explicit preparation, never routing an old
      // descriptor to an implementation discovered later under the same name.
      const fingerprint = JSON.stringify(inventory);
      return {
        tools: inventory,
        subscribeInvalidated(listener) {
          const removeStatus = client.subscribeStatus(() => { if (!current()) listener(); });
          const removeNotification = client.subscribeNotification(event => {
            if (!["mcpServer/startupStatus/updated", "mcpServer/oauthLogin/completed"].includes(event.method)) return;
            const params = event.params as { name?: unknown };
            if (params?.name === options.server) listener();
          });
          return () => { removeStatus(); removeNotification(); };
        },
        async checkAccess(context) {
          if (!current() || context.hostId !== target.hostId) return false;
          const value = await status(context.threadId, context.signal);
          return current() && allowed(value) && JSON.stringify(value.tools) === fingerprint;
        },
        async call(name, input, context) {
          if (!current() || context.hostId !== target.hostId) throw new ConnectorError("stale-handle");
          const params: McpServerToolCallParams = { threadId: context.threadId, server: options.server, tool: name, arguments: input as McpServerToolCallParams["arguments"] };
          const result = objectInput(await client.requestRaw("mcpServer/tool/call", params, { signal: context.signal }));
          if (result.isError === true) throw new ConnectorError("failed");
          return result;
        },
        dispose() { disposed = true; },
      };
    } }],
  };
}
