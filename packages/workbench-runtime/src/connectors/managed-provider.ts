import type { AppServerClient } from "@opencraft/appserver-client";
import type { ConnectorHostSnapshot, ConnectorInstance, ConnectorNativeTool } from "@opencraft/connector-core";
import type { ConnectorProvider } from "./contract";
import { ConnectorError, objectInput } from "./lifetime";

export function managedSnapshot(raw: unknown): ConnectorHostSnapshot {
  const value = objectInput(raw);
  if (value.protocolVersion !== 1 || !Array.isArray(value.instances) || !Array.isArray(value.supportedDefinitions)) throw new ConnectorError("unavailable");
  return { protocolVersion: 1, supportedDefinitions: value.supportedDefinitions.map(value => { if (typeof value !== "string") throw new ConnectorError("invalid-input"); return value; }),
    instances: value.instances.map(raw => {
      const row = objectInput(raw);
      if (typeof row.id !== "string" || typeof row.definitionId !== "string" || typeof row.title !== "string" || !Number.isInteger(row.revision)
        || typeof row.enabled !== "boolean" || !Array.isArray(row.configuredFields) || !["configured", "required"].includes(String(row.authorization))) throw new ConnectorError("invalid-input");
      return { id: row.id, definitionId: row.definitionId, title: row.title, revision: Number(row.revision), enabled: row.enabled,
        values: objectInput(row.values) as Record<string, string>, configuredFields: row.configuredFields as string[], authorization: row.authorization as ConnectorInstance["authorization"], updatedAt: Number(row.updatedAt) };
    }) };
}
export function createManagedConnectorProvider(id: string, title: string, instanceId: string, resolve: (hostId: string) => Promise<AppServerClient>): ConnectorProvider {
  return { id, title, contributions: [{ id: "managed-tools", kind: "tools", prepare: async context => {
    const client = await resolve(context.target.hostId), generation = client.connectionGeneration;
    if (client.hostId !== context.target.hostId) throw new ConnectorError("unavailable");
    const inventory = objectInput(await client.requestRaw("connectors/managed/tools", { id: instanceId }, { signal: context.signal }));
    if (!Array.isArray(inventory.tools) || typeof inventory.digest !== "string" || !Number.isInteger(inventory.revision)) throw new ConnectorError("invalid-input");
    return {
      tools: inventory.tools as unknown as readonly ConnectorNativeTool[],
      checkAccess: async ({ signal }) => {
        if (client.status.state !== "open" || client.connectionGeneration !== generation || await resolve(context.target.hostId) !== client) return false;
        const snapshot = managedSnapshot(await client.requestRaw("connectors/managed/list", {}, { signal }));
        return snapshot.instances.some(row => row.id === instanceId && row.enabled && row.revision === inventory.revision && row.authorization === "configured");
      },
      call: (tool, args, { signal }) => client.requestRaw("connectors/managed/call", { id: instanceId, revision: inventory.revision, digest: inventory.digest, tool, arguments: args }, { signal }),
      subscribeInvalidated: listener => {
        const stop = client.subscribeNotification(event => { if (event.method === "connectors/managed/changed" && (event.params as { id?: string })?.id === instanceId) listener(); });
        const status = client.subscribeStatus(state => { if (state.state !== "open" || client.connectionGeneration !== generation) listener(); });
        return () => { stop(); status(); };
      },
      dispose() {},
    };
  } }] };
}
