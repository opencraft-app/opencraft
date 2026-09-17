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
} from "@opencraft/workbench-runtime";

export const OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS = Object.freeze([
  ...OPENCRAFT_BROWSER_DYNAMIC_TOOLS,
  ...OPENCRAFT_TERMINAL_DYNAMIC_TOOLS,
]);

export interface WorkbenchDynamicToolHosts {
  readonly browser: BrowserDynamicToolHost;
  readonly terminal: ConversationTerminalToolHost;
}

export function installWorkbenchDynamicToolHandlers(
  client: Pick<AppServerClient, "interceptServerRequest">,
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
  return () => {
    removeTerminal();
    removeBrowser();
  };
}
