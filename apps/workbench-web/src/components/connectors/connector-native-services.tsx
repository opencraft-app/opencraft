import { useState, useSyncExternalStore } from "react";
import { connectorErrorMessage, type ConnectorManager, type McpInventoryRow } from "@opencraft/workbench-runtime";
import { SettingsGroup, SettingsListItem, SettingsNotice } from "@opencraft/extension-react";
import { Button } from "../ui/button";

/** Native MCP discovery retains its Host authority, separate from managed setup. */
export function ConnectorNativeServices({ hostId, manager }: { hostId: string; manager: ConnectorManager }) {
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const [servers, setServers] = useState<readonly McpInventoryRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  async function discover() {
    setLoading(true); setError(null);
    try { setServers(await manager.discover(hostId)); }
    catch (error) { setError(connectorErrorMessage("discover", error)); }
    finally { setLoading(false); }
  }
  async function add(name: string) {
    setPending(previous => new Set([...previous, name])); setError(null);
    try { await manager.add(hostId, name); }
    catch (error) { setError(connectorErrorMessage("add", error)); }
    finally { setPending(previous => { const next = new Set(previous); next.delete(name); return next; }); }
  }
  return <details className="connector-native">
    <summary className="ui-native-disclosure">已有 MCP 服务？</summary>
    <div className="connector-native__body">
      <p>读取此设备已配置的 MCP 服务，不改动原有配置。</p>
      <Button variant="secondary" loading={loading} onClick={() => void discover()}>读取 MCP 服务</Button>
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      {servers?.length === 0 ? <SettingsNotice>没有发现已配置的原生 MCP 服务。</SettingsNotice> : null}
      {servers?.length ? <SettingsGroup>{servers.map(server => {
        const saved = snapshot.configuration.connectors.some(row => row.hostId === hostId && row.kind !== "managed" && row.server === server.name);
        return <SettingsListItem key={server.name} label={server.name} metadata={`${server.toolCount} 个工具`}
          actions={<Button variant="secondary" size="sm" disabled={saved || pending.has(server.name)} onClick={() => void add(server.name)}>{saved ? "已添加" : "添加连接器"}</Button>} />;
      })}</SettingsGroup> : null}
    </div>
  </details>;
}
