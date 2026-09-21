import type { AppServerConnection } from "./appserver.ts";
import type { McpAppLaunchRequest } from "./mcp.ts";

export interface McpAppBuilderPort {
  launchRequest(appId: string, connection: AppServerConnection): McpAppLaunchRequest;
  executeAgent(argumentsValue: Record<string, unknown>, principalId: string): { text: string };
}
