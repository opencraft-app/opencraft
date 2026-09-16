import type { AppServerConnection } from "./appserver.ts";

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolCallResult {
  content: Array<McpTextContent | Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean | null;
  _meta?: unknown;
}

export interface PendingMcpToolCall {
  kind: "pending";
  poll(): McpToolCallResult | null;
  cancel?(): void;
  timeoutMs?: number;
}

export interface McpAppLaunchRequest {
  kind: "mcpAppLaunch";
  server: string;
  tool: string;
  arguments: unknown;
  resourceUri: string;
  pluginId?: string | null;
  appName?: string | null;
  actionName?: string | null;
  readOnlyHint?: boolean | null;
}

export interface McpToolInvocation {
  server: string;
  tool: string;
  threadId: string;
  arguments?: unknown;
  meta?: unknown;
}

export interface McpToolCallContext {
  connection: AppServerConnection;
  server: string;
  threadId: string;
  tool: string;
  meta: unknown;
}

export interface McpToolRegistration {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  icons?: unknown[] | null;
  _meta?: unknown;
  call(
    argumentsValue: unknown,
    context: McpToolCallContext,
  ): McpToolCallResult | PendingMcpToolCall;
}

export interface McpResourceRegistration {
  uri: string;
  name: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
  annotations?: unknown;
  icons?: unknown[] | null;
  read(): string | { text: string; mimeType?: string | null; _meta?: unknown };
}

export interface McpServerRegistration {
  name: string;
  pluginId?: string | null;
  title?: string | null;
  description?: string | null;
  version: string;
  websiteUrl?: string | null;
  icons?: unknown[] | null;
  tools: McpToolRegistration[];
  resources: McpResourceRegistration[];
  visible?(connection: AppServerConnection): boolean;
}

export interface McpRegistryPort {
  registerServer(server: McpServerRegistration): () => boolean;
  replaceServer(server: McpServerRegistration): () => boolean;
  removeServer(name: string): boolean;
  callTool(
    invocation: McpToolInvocation,
    connection: AppServerConnection,
  ): McpToolCallResult | PendingMcpToolCall;
  tick(): void;
}
