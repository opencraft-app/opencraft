import type { AuthenticationSession } from "../authentication/contract";

export const CONNECTOR_PROVIDER_CHANNEL = "connectorProvider";
export interface ConnectorScope { readonly hostId: string; readonly threadId: string }
export interface ConnectorTarget { readonly hostId: string }
export interface ConnectorAuthorizationPort {
  getSession(providerId: string): AuthenticationSession | null;
  subscribe(listener: () => void): () => void;
}
export interface ConnectorTool {
  /** False includes unknown effects; it requires one-shot user approval. */
  readonly readOnly: boolean;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface ConnectorPreparation {
  readonly target: ConnectorTarget;
  readonly signal: AbortSignal;
  /** Reference only. The Authentication provider retains account and credentials. */
  readonly authorization: { readonly providerId: string; readonly epoch: number } | null;
}
export interface ConnectorResource { dispose(): void | Promise<void> }
export interface ConnectorToolResource extends ConnectorResource {
  readonly tools: readonly ConnectorTool[];
  subscribeInvalidated?(listener: () => void): () => void;
  /** Recheck service-side availability/authorization; cached UI state is insufficient. */
  checkAccess(context: ConnectorScope & { readonly signal: AbortSignal }): Promise<boolean>;
  call(name: string, input: Readonly<Record<string, unknown>>, context: ConnectorScope & { readonly signal: AbortSignal }): Promise<unknown>;
}
export interface ConnectorSkillResource extends ConnectorResource {
  /** An installation-service receipt, not model context or a file/credential copy. */
  readonly receipt: { readonly installationId: string; readonly refresh: "applied" | "pending" | "unsupported" };
}
export type ConnectorContribution =
  | { readonly id: string; readonly kind: "tools"; prepare(context: ConnectorPreparation): Promise<ConnectorToolResource> }
  | { readonly id: string; readonly kind: "skills"; prepare(context: ConnectorPreparation): Promise<ConnectorSkillResource> };
/** First-party SPI, not a frozen public plugin manifest or a new MCP transport. */
export interface ConnectorProvider {
  readonly id: string;
  readonly title: string;
  readonly authenticationProviderId?: string;
  readonly contributions: readonly ConnectorContribution[];
}
export type ConnectorPhase = "preparing" | "ready" | "partial" | "failed" | "authorization-required" | "refresh-required" | "disconnected";
export interface ConnectorSnapshot {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly hostId: string;
  readonly operationId: string;
  readonly phase: ConnectorPhase;
  readonly contributions: readonly {
    readonly id: string;
    readonly kind: "tools" | "skills";
    readonly phase: "ready" | "pending" | "unsupported" | "failed";
  }[];
}
export interface ConnectorDiscoveredTool extends ConnectorTool {
  readonly handle: string;
  readonly connectorId: string;
}

/** Engine-neutral identity used only between ConnectorRuntime and its capability projection. */
export interface ConnectorCapabilityIdentity {
  readonly connectionId: string;
  readonly contributionId: string;
  readonly toolName: string;
  readonly schemaDigest: string;
}

export interface ConnectorCapabilityEntry extends ConnectorTool {
  readonly connectorId: string;
  readonly connectorTitle: string;
  readonly identity: ConnectorCapabilityIdentity;
}

export interface ConnectorCapabilityView {
  /** Scope-local generation + inventory digest. It is not a persistent revision. */
  readonly revision: string;
  readonly entries: readonly ConnectorCapabilityEntry[];
}
