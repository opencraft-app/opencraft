import type { AppServerClient } from "@opencraft/appserver-client";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
} from "@opencraft/appserver-protocol/generated/v2";
import { BROWSER_TOOL_CATALOG, executeBrowserTool, type BrowserToolHost } from "@opencraft/browser-core";

// Preserve the adapter API while keeping semantics in browser-core.
export { OPENCRAFT_BROWSER_EXTENSION, OPENCRAFT_BROWSER_CAPABILITY, BrowserToolError } from "@opencraft/browser-core";
export type {
  BrowserToolContext as BrowserDynamicToolContext,
  BrowserToolHost as BrowserDynamicToolHost,
} from "@opencraft/browser-core";

export const OPENCRAFT_BROWSER_DYNAMIC_TOOLS: readonly DynamicToolSpec[] = Object.freeze(
  BROWSER_TOOL_CATALOG.map(namespace => ({
    type: "namespace" as const,
    name: namespace.name,
    description: namespace.description,
    tools: namespace.tools.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema } })),
  })),
);

export function installBrowserDynamicToolHandler(
  client: Pick<AppServerClient, "interceptServerRequest">,
  host: BrowserToolHost,
  options: { readonly hostId: string },
): () => void {
  return client.interceptServerRequest(async (request, next) => {
    if (request.method !== "item/tool/call") return next();
    const params = request.params as DynamicToolCallParams;
    const result = await executeBrowserTool(host, {
      hostId: options.hostId,
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
    }, {
      namespace: params.namespace === "vela_app" ? "opencraft_app"
        : params.namespace === "vela_browser" ? "opencraft_browser" : params.namespace ?? null,
      name: params.namespace === "vela_app" && params.tool === "open_in_vela"
        ? "open_in_opencraft" : params.tool,
    }, params.arguments);
    if (result === null) return next();
    const response: DynamicToolCallResponse = {
      success: result.success,
      contentItems: result.content.map(item => item.type === "image"
        ? { type: "inputImage", imageUrl: item.imageUrl }
        : { type: "inputText", text: item.text }),
    };
    return response;
  });
}
