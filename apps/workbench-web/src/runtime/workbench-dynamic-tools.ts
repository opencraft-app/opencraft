import { MCP_APPS_DYNAMIC_TOOLS } from "@opencraft/appserver-protocol/mcp-apps";
import { installMcpAppsDynamicToolHandler } from "@opencraft/mcp-apps/dynamic-tools";
import type { AppServerClient } from "@opencraft/appserver-client";
import {
  installBrowserDynamicToolHandler,
  OPENCRAFT_BROWSER_DYNAMIC_TOOLS,
  type BrowserDynamicToolHost,
} from "@opencraft/browser-appserver";
import {
  installConversationTerminalDynamicToolHandler,
  OPENCRAFT_TERMINAL_DYNAMIC_TOOLS,
  type ConversationTerminalToolHost,
  OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS,
  installConnectorDynamicToolHandler,
  type ConnectorRuntime,
} from "@opencraft/workbench-runtime";

export const OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS = Object.freeze([
  ...OPENCRAFT_BROWSER_DYNAMIC_TOOLS,
  ...OPENCRAFT_TERMINAL_DYNAMIC_TOOLS,
  ...OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS,
  ...MCP_APPS_DYNAMIC_TOOLS,
]);

export interface WorkbenchDynamicToolHosts {
  readonly browser: BrowserDynamicToolHost;
  readonly terminal: ConversationTerminalToolHost;
  readonly connectors: ConnectorRuntime;
}

export function installWorkbenchDynamicToolHandlers(
  client: Pick<AppServerClient, "interceptServerRequest" | "subscribeNotification" | "requestRaw">,
  hosts: WorkbenchDynamicToolHosts,
  options: { readonly hostId: string },
): () => void {
  const removeBrowser = installBrowserDynamicToolHandler(
    client,
    hosts.browser,
    options,
  );
  const removeTerminal = installConversationTerminalDynamicToolHandler(
    client,
    hosts.terminal,
    options,
  );
  const removeApps = installMcpAppsDynamicToolHandler(client);
  const removeConnectors = installConnectorDynamicToolHandler(client, hosts.connectors, options);
  return () => {
    removeApps();
    removeConnectors();
    removeTerminal();
    removeBrowser();
  };
}
