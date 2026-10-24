/** Product-owned integrations. No engine, transport, React or database dependency. */
export interface ConnectorField {
  readonly key: string;
  readonly label: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly placeholder?: string;
}
export interface ConnectorDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: "办公" | "知识" | "效率" | "媒体" | "出行" | "专业" | "自托管";
  readonly adapter: "mcp" | "api" | "mail" | "cli";
  readonly auth: "token" | "oauth" | "fields";
  readonly guideUrl: string;
  readonly steps: readonly string[];
  readonly fields: readonly ConnectorField[];
}
export interface ConnectorInstance {
  readonly id: string;
  readonly definitionId: string;
  readonly title: string;
  readonly revision: number;
  readonly enabled: boolean;
  /** Only nonsecret fields and secret-presence flags cross the Host boundary. */
  readonly values: Readonly<Record<string, string>>;
  readonly configuredFields: readonly string[];
  readonly authorization: "configured" | "required";
  readonly updatedAt: number;
}
export interface ConnectorSave {
  readonly id: string;
  readonly definitionId: string;
  readonly title: string;
  readonly expectedRevision: number;
  readonly values: Readonly<Record<string, string>>;
  /** Absent secrets are kept for the same identity; an empty value explicitly clears. */
  readonly secrets: Readonly<Record<string, string>>;
}
export interface ConnectorProbe {
  readonly level: "format" | "authenticated" | "tools";
  readonly toolCount: number;
  readonly tools: readonly { readonly name: string; readonly description: string; readonly readOnly: boolean }[];
}
export interface ConnectorHostSnapshot {
  readonly protocolVersion: 1;
  readonly supportedDefinitions: readonly string[];
  readonly instances: readonly ConnectorInstance[];
}
export interface ConnectorNativeTool {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface ConnectorOAuthProgress {
  readonly id: string;
  readonly status: "pending" | "complete" | "cancelled" | "failed" | "expired";
  readonly authorizationUrl?: string;
}
