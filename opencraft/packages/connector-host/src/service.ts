import { connectorDefinition, type ConnectorHostSnapshot, type ConnectorProbe } from "@opencraft/connector-core";
import { ConnectorDatabase, ConnectorHostError, record, text } from "./store";
import { ConnectorOAuth } from "./oauth";
import { ConnectorMcp, toolsDigest } from "./mcp";
import { MCP_DEFINITIONS } from "./mcp-endpoints";
import { API_DEFINITIONS, API_TOOLS, callApi, validateApi } from "./api";

const SUPPORTED = [...MCP_DEFINITIONS, ...API_DEFINITIONS];
/** Called by authenticated Host transport, not by an engine-specific plugin. */
export class ManagedConnectorService {
  readonly database: ConnectorDatabase;
  private readonly oauth: ConnectorOAuth;
  private readonly mcp: ConnectorMcp;
  private readonly listeners = new Set<(id: string) => void>();
  constructor(path: string, private readonly fetchOverride?: typeof fetch) {
    this.database = new ConnectorDatabase(path);
    this.oauth = new ConnectorOAuth(this.database, id => this.changed(id));
    this.mcp = new ConnectorMcp(this.database, this.oauth, undefined, fetchOverride);
  }
  subscribe(listener: (id: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(id: string) { for (const listener of this.listeners) listener(id); }
  list(): ConnectorHostSnapshot { return { protocolVersion: 1, supportedDefinitions: SUPPORTED, instances: this.database.list() }; }
  private supported(id: string) {
    const row = this.database.get(id);
    if (!SUPPORTED.includes(row.definitionId)) throw new ConnectorHostError("unsupported");
    if (!row.enabled) throw new ConnectorHostError("unavailable");
    return row;
  }
  async tools(id: string) {
    const row = this.supported(id);
    const tools = API_TOOLS[row.definitionId] ?? await this.mcp.list(id);
    return { revision: row.revision, digest: toolsDigest(tools), tools };
  }
  async probe(id: string): Promise<ConnectorProbe> {
    const row = this.supported(id);
    if (API_TOOLS[row.definitionId]) {
      validateApi(row);
      // No billable query or real user content is fetched as an invisible validation step.
      return { level: "format", tools: API_TOOLS[row.definitionId], toolCount: API_TOOLS[row.definitionId].length };
    }
    const inventory = await this.tools(id);
    return { level: "tools", tools: inventory.tools, toolCount: inventory.tools.length };
  }
  async handle(method: string, raw: unknown): Promise<unknown> {
    const params = raw === undefined || raw === null ? {} : record(raw);
    try {
      switch (method) {
        case "connectors/managed/list": return this.list();
        case "connectors/managed/save": {
          const definition = connectorDefinition(text(params.definitionId));
          if (!SUPPORTED.includes(definition.id)) throw new ConnectorHostError("unsupported");
          const saved = this.database.save(params); this.oauth.cancelInstance(saved.id); this.changed(saved.id); return saved;
        }
        case "connectors/managed/delete": {
          const id = text(params.id); if (this.database.get(id).revision !== Number(params.revision)) throw new ConnectorHostError("conflict");
          this.oauth.cancelInstance(id); this.database.remove(id, Number(params.revision)); this.changed(id); return {};
        }
        case "connectors/managed/setEnabled": {
          if (typeof params.enabled !== "boolean") throw new ConnectorHostError("invalid");
          const row = this.database.setEnabled(text(params.id), Number(params.revision), params.enabled);
          this.oauth.cancelInstance(row.id); this.changed(row.id); return row;
        }
        case "connectors/managed/probe": return await this.probe(text(params.id));
        case "connectors/managed/tools": return await this.tools(text(params.id));
        case "connectors/managed/call": {
          const id = text(params.id), row = this.supported(id), expected = Number(params.revision), tool = text(params.tool);
          if (row.revision !== expected) throw new ConnectorHostError("conflict");
          const args = record(params.arguments); if (JSON.stringify(args).length > 65536) throw new ConnectorHostError("invalid");
          const inventory = await this.tools(id);
          if (inventory.digest !== params.digest || !inventory.tools.some(t => t.name === tool) || this.database.get(id).revision !== expected) throw new ConnectorHostError("conflict");
          const value = API_TOOLS[row.definitionId] ? await callApi(row, tool, args, this.fetchOverride) : await this.mcp.call(id, expected, inventory.digest, tool, args);
          if (this.database.get(id).revision !== expected) throw new ConnectorHostError("conflict");
          let serialized = JSON.stringify(value); if (serialized.length > 262144) throw new ConnectorHostError("unavailable");
          const tokens = row.oauth.tokens ? record(row.oauth.tokens) : {};
          for (const secret of [...Object.values(row.secrets), tokens.access_token, tokens.refresh_token]) if (typeof secret === "string" && secret.length >= 6) serialized = serialized.split(secret).join("[redacted]");
          return JSON.parse(serialized);
        }
        case "connectors/managed/oauth/start": return await this.oauth.start(text(params.id));
        case "connectors/managed/oauth/status": return this.oauth.progress(text(params.id));
        case "connectors/managed/oauth/cancel": this.oauth.cancel(text(params.id)); return {};
        default: throw new ConnectorHostError("unsupported");
      }
    } catch (error) {
      // SDK/HTTP/OAuth exceptions may contain raw credentials or secret endpoint URLs.
      throw error instanceof ConnectorHostError ? error : new ConnectorHostError("unavailable");
    }
  }
  close() { this.oauth.dispose(); this.listeners.clear(); this.database.close(); }
}
