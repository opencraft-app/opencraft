/** Narrow, owner-bound capabilities. App HTML never receives an AppServer client. */
export interface McpAppPort {
  readonly key: string;
  /** Application-memory view data only; never an executable capability. */
  widgetState?(viewId: string, identity: McpAppIdentity): McpAppWidgetState;
  assertCurrent(): void;
  readResource(server: string, uri: string, callId: string | null): Promise<unknown>;
  listTools(server: string, resourceUri?: string): Promise<Record<string, unknown>>;
  callTool(server: string, tool: string, args: Record<string, unknown>, resourceUri?: string): Promise<unknown>;
  sendMessage(text: string): Promise<void>;
  updateContext(id: string, value: string | null): void;
  openLink(url: string): void;
}
export interface McpAppWidgetState {
  current: unknown;
  /** Host UI intent, separate from the App-authored JSON in current. */
  pausedByUser?: boolean;
}
export type McpAppWidgetStateStore = Map<string, McpAppWidgetState>;
export interface McpAppIdentity {
  readonly server: string;
  readonly uri: string;
  readonly callId: string | null;
  readonly name: string;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function boundedJson(value: unknown, limit = 131072): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || text.length > limit) throw new Error("App data exceeds its size limit");
  return text;
}
export function textContent(value: unknown): string {
  if (!Array.isArray(value)) throw new Error("Expected text content");
  const texts = value.map(entry => {
    const item = record(entry);
    if (item.type !== "text" || typeof item.text !== "string") throw new Error("Only text content is supported");
    return item.text;
  });
  const text = texts.join("\n");
  if (text.length > 32768) throw new Error("App text exceeds its size limit");
  return text;
}
export function externalUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected an external URL");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsupported external URL");
  return url.href;
}
