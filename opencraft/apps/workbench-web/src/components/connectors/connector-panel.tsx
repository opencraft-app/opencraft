import { useEffect, useState, useSyncExternalStore } from "react";
import { connectorErrorMessage, type ConnectorOperation, type ConnectorManager, type ConnectorApprovalQueue } from "@opencraft/workbench-runtime";
import type { ModalRequest } from "../modal";
import { Button } from "../ui/button";
import "./connector-panel.scss";

const labels: Record<string, string> = { ready: "已连接", partial: "部分可用", connecting: "正在连接", preparing: "正在准备", authorizing: "等待授权", "authorization-ready": "授权已完成，请确认连接", disconnected: "已断开", cancelled: "已取消", failed: "连接失败", error: "连接未完成", "authorization-required": "需要授权", "refresh-required": "需要重新连接" };

export function ConnectorPanel({ manager, hostId, scopeId, owner, onManage }: { manager: ConnectorManager; hostId: string; scopeId: string; owner: string; onManage?: () => void }) {
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const managed = useSyncExternalStore(manager.managed.subscribe, () => manager.managed.snapshot(hostId), () => manager.managed.snapshot(hostId));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { setErrors({}); void manager.managed.load(hostId); }, [hostId, manager]);
  const action = async (id: string, operation: ConnectorOperation, work: () => Promise<unknown>) => {
    setPending(previous => new Set([...previous, id])); setErrors(previous => { const next = { ...previous }; delete next[id]; return next; });
    try { await work(); } catch (error) { setErrors(previous => ({ ...previous, [id]: connectorErrorMessage(operation, error) })); }
    finally { setPending(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  };
  const rows = snapshot.configuration.connectors.filter(c => c.hostId === hostId && c.kind !== "managed");
  return <section className="connector-panel" aria-label="本会话连接器">
    <header><h2>会话连接器</h2><p>只为当前会话启用已配置的服务。写操作每次单独确认。</p></header>
    {onManage ? <Button variant="secondary" onClick={onManage}>管理连接器</Button> : null}
    {managed.data?.instances.map(row => {
      const link = snapshot.configuration.connectors.find(c => c.hostId === hostId && c.kind === "managed" && c.server === row.id);
      const selected = !!link && manager.selectionConfirmed(hostId, scopeId, link.id);
      return <div key={row.id}><label className="connector-panel__selection"><input type="checkbox" checked={selected} disabled={!row.enabled || row.authorization === "required" || pending.has(row.id)}
        onChange={e => { const enabled = e.target.checked; void action(row.id, "select", async () => {
          const id = link?.id ?? await manager.managed.link(hostId, row);
          if (enabled) {
            await manager.connect(id, owner);
            const error = manager.getSnapshot().states[id]?.error;
            if (error) { setErrors(previous => ({ ...previous, [row.id]: error })); return; }
          }
          await manager.select(hostId, scopeId, id, enabled);
        }); }} />{row.title}</label>
        {row.authorization === "required" ? <p className="connector-panel__meta">请先到 Skills → 连接器完成授权。</p> : null}
        {errors[row.id] ? <p role="alert">{errors[row.id]}</p> : null}
      </div>;
    })}
    <p className="connector-panel__meta">设备：{hostId}</p>
    {snapshot.error ? <p role="alert">{snapshot.error} <Button variant="secondary" onClick={() => void manager.reload()}>重试读取</Button></p> : null}
    {rows.length === 0 && !managed.data?.instances.length ? <p className="connector-panel__empty">还没有连接。到 Skills 的“连接器”页添加服务。</p> : <ul className="connector-panel__list">{rows.map(row => {
      const state = snapshot.states[row.id], phase = state?.phase ?? "saved";
      const busy = ["connecting", "authorizing", "preparing"].includes(phase), ready = ["ready", "partial"].includes(phase);
      const saved = manager.savedSelection(hostId, scopeId, row.id), confirmed = manager.selectionConfirmed(hostId, scopeId, row.id);
      return <li key={row.id} aria-busy={busy}>
        <div><h3>{row.title}</h3><p role="status">{labels[phase] ?? "已保存，等待连接"}</p></div>
        <div className="connector-panel__actions">
          {busy ? <Button variant="secondary" onClick={() => manager.cancel(row.id)}>取消等待</Button> : <Button variant="secondary" onClick={() => void action(row.id, "connect", () => manager.connect(row.id, owner))}>{ready ? "重新连接" : phase === "authorization-ready" ? "确认连接" : "连接 / 授权"}</Button>}
          {ready ? <Button variant="ghost" onClick={() => void action(row.id, "disconnect", () => manager.disconnect(row.id))}>断开</Button> : null}
        </div>
        {state?.authorizationUrl ? <p><Button variant="primary" onClick={() => window.open(state.authorizationUrl!, "_blank", "noopener,noreferrer")}>打开授权页面</Button><span> 完成后返回此处确认连接，不会自动启用会话访问。</span></p> : null}
        {state?.error ? <p role="alert">{state.error}</p> : null}
        {errors[row.id] ? <p role="alert">{errors[row.id]}</p> : null}
        <label className="connector-panel__selection"><input type="checkbox" checked={saved && confirmed && ready} disabled={!ready || pending.has(row.id)} onChange={e => void action(row.id, "select", () => manager.select(hostId, scopeId, row.id, e.target.checked))} />用于当前会话</label>
        {saved && !confirmed ? <p className="connector-panel__meta">已记住选择；连接后请重新确认本会话使用。</p> : null}
      </li>;
    })}</ul>}
  </section>;
}

export function useConnectorPresentation(manager: ConnectorManager, approvals: ConnectorApprovalQueue, scope: { hostId: string; scopeId: string }, onManage?: () => void) {
  const [owner, setOwner] = useState<string | null>(null);
  const pending = useSyncExternalStore(approvals.subscribe, approvals.getSnapshot, approvals.getSnapshot);
  useEffect(() => { if (!owner) return; return () => manager.cancelOwner(owner); }, [manager, owner, scope.hostId, scope.scopeId]);
  const requests: ModalRequest[] = [];
  if (owner) requests.push({ id: owner, label: "连接器", size: "wide", appearance: "utility", dismissOnOutsidePress: false,
    onDismiss: () => { manager.cancelOwner(owner); setOwner(null); }, content: <ConnectorPanel key={`${scope.hostId}:${scope.scopeId}`} manager={manager} {...scope} owner={owner}
      onManage={onManage ? () => { manager.cancelOwner(owner); setOwner(null); onManage(); } : undefined} /> });
  const approval = pending[0];
  if (approval) requests.push({ id: approval.id, label: "确认连接器写操作", layer: "confirmation", size: "wide", appearance: "utility",
    onDismiss: () => approvals.respond(approval.id, false), confirmation: { confirmLabel: "仅允许这一次", cancelLabel: "拒绝", onConfirm: () => approvals.respond(approval.id, true) },
    content: <section className="connector-panel"><h2>允许这次写操作？</h2><p>{approval.connectorTitle} · {approval.tool}</p><p>{approval.description}</p>
      <p className="connector-panel__meta">设备：{approval.hostId}<br />会话：{approval.threadId}</p><pre aria-label="待执行参数">{approval.argumentsPreview}</pre><p>仅允许本次操作，之后的写入仍需确认。</p></section> });
  return { requests, launcher: <Button variant="ghost" size="sm" aria-haspopup="dialog" onClick={() => setOwner(`connector-panel:${crypto.randomUUID()}`)}>连接器</Button> };
}
