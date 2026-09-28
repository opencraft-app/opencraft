export interface SavedConnector { readonly id: string; readonly hostId: string; readonly server: string; readonly title: string; readonly kind?: "managed" }
export interface SavedConnectorSelection { readonly scopeId: string; readonly hostId: string; readonly connectorIds: readonly string[] }
export interface ConnectorConfiguration {
  readonly version: 1;
  readonly connectors: readonly SavedConnector[];
  readonly selections: readonly SavedConnectorSelection[];
}
export interface ConnectorConfigurationRecord { readonly revision: number; readonly value: ConnectorConfiguration }
export interface ConnectorConfigurationStore {
  load(): Promise<ConnectorConfigurationRecord>;
  compareAndSet(expectedRevision: number, value: ConnectorConfiguration): Promise<{ readonly updated: boolean; readonly record: ConnectorConfigurationRecord }>;
  subscribe?(listener: () => void): () => void;
  close?(): void | Promise<void>;
}
export const emptyConnectorConfiguration = (): ConnectorConfiguration => ({ version: 1, connectors: [], selections: [] });

/** Strict allowlist: no token, authorization URL, runtime handle or approval can be persisted. */
export function parseConnectorConfiguration(input: unknown): ConnectorConfiguration {
  const object = (value: unknown, keys: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new TypeError("Invalid Connector configuration");
    return value as Record<string, unknown>;
  };
  const string = (value: unknown) => { if (typeof value !== "string" || !value.trim() || value.length > 512) throw new TypeError("Invalid Connector identity"); return value; };
  const root = object(input, ["version", "connectors", "selections"]);
  if (root.version !== 1 || !Array.isArray(root.connectors) || root.connectors.length > 128 || !Array.isArray(root.selections) || root.selections.length > 4096) throw new TypeError("Invalid Connector configuration");
  const connectors = root.connectors.map(raw => {
    const value = object(raw, ["id", "hostId", "server", "title", "kind"]);
    if (value.kind !== undefined && value.kind !== "managed") throw new TypeError("Invalid Connector kind");
    return { id: string(value.id), hostId: string(value.hostId), server: string(value.server), title: string(value.title), ...(value.kind === "managed" ? { kind: "managed" as const } : {}) };
  });
  if (new Set(connectors.map(c => c.id)).size !== connectors.length || new Set(connectors.map(c => JSON.stringify([c.hostId, c.kind, c.server]))).size !== connectors.length) throw new TypeError("Duplicate Connector configuration");
  const selections = root.selections.map(raw => {
    const value = object(raw, ["scopeId", "hostId", "connectorIds"]);
    if (!Array.isArray(value.connectorIds) || value.connectorIds.length > 128) throw new TypeError("Invalid Connector selection");
    const hostId = string(value.hostId), connectorIds = value.connectorIds.map(string);
    if (new Set(connectorIds).size !== connectorIds.length || connectorIds.some(id => !connectors.some(c => c.id === id && c.hostId === hostId))) throw new TypeError("Foreign Connector selection");
    return { scopeId: string(value.scopeId), hostId, connectorIds };
  });
  if (new Set(selections.map(s => JSON.stringify([s.hostId, s.scopeId]))).size !== selections.length) throw new TypeError("Duplicate Connector selection");
  return { version: 1, connectors, selections };
}

export class MemoryConnectorConfigurationStore implements ConnectorConfigurationStore {
  private record: ConnectorConfigurationRecord = { revision: 0, value: emptyConnectorConfiguration() };
  async load() { return structuredClone(this.record); }
  async compareAndSet(expectedRevision: number, value: ConnectorConfiguration) {
    if (expectedRevision !== this.record.revision) return { updated: false, record: await this.load() };
    this.record = { revision: expectedRevision + 1, value: parseConnectorConfiguration(value) };
    return { updated: true, record: await this.load() };
  }
}
