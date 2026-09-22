import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { type ConnectorManager, type ConnectorApprovalQueue } from "@opencraft/workbench-runtime";
import { useIntl } from "@opencraft/i18n/react";
import type { ModalRequest } from "../modal";
import { useWorkbenchPresentationRoot } from "../workbench-presentation-root";
import { ConnectorAddMenuItem, type ConnectorQuickItem, ConnectorStatusChip } from "./connector-quick-picker";
import "./connector-panel.scss";

export function useConnectorPresentation(manager: ConnectorManager, approvals: ConnectorApprovalQueue, scope: { hostId: string; scopeId: string }, onManage?: () => void) {
  const intl = useIntl();
  const portalContainer = useWorkbenchPresentationRoot();
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const managed = useSyncExternalStore(manager.managed.subscribe, () => manager.managed.snapshot(scope.hostId), () => manager.managed.snapshot(scope.hostId));
  const approvalsSnapshot = useSyncExternalStore(approvals.subscribe, approvals.getSnapshot, approvals.getSnapshot);
  const [selectionPending, setSelectionPending] = useState<ReadonlySet<string>>(new Set());
  const [selectionErrors, setSelectionErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const operationOwner = useMemo(() => `connector-scope:${scope.hostId}:${scope.scopeId}:${crypto.randomUUID()}`, [scope.hostId, scope.scopeId]);
  useEffect(() => { void manager.managed.load(scope.hostId); }, [manager, scope.hostId]);
  // Connection and authorization belong to the conversation scope, not to an
  // open Popover. Closing a quick picker must never cancel in-flight work.
  useEffect(() => () => manager.cancelOwner(operationOwner), [manager, operationOwner]);

  const quickItems = useMemo<readonly ConnectorQuickItem[]>(() => {
    const phaseLabel = (phase: string) => ({
      connecting: intl.formatMessage({ id: "connector.status.cancel", defaultMessage: "Cancel" }),
      preparing: intl.formatMessage({ id: "connector.status.cancel", defaultMessage: "Cancel" }),
      authorizing: intl.formatMessage({ id: "connector.status.openAuthorization", defaultMessage: "Open authorization" }),
      "authorization-ready": intl.formatMessage({ id: "connector.status.confirm", defaultMessage: "Confirm" }),
      disconnected: intl.formatMessage({ id: "connector.status.connect", defaultMessage: "Connect" }),
      cancelled: intl.formatMessage({ id: "connector.status.connect", defaultMessage: "Connect" }),
      failed: intl.formatMessage({ id: "connector.status.retry", defaultMessage: "Retry" }),
      error: intl.formatMessage({ id: "connector.status.retry", defaultMessage: "Retry" }),
    }[phase] ?? intl.formatMessage({ id: "connector.status.connect", defaultMessage: "Connect" }));
    const managedItems = (managed.data?.instances ?? []).map(row => {
      const itemId = `managed:${row.id}`;
      const link = snapshot.configuration.connectors.find(connector => connector.hostId === scope.hostId && connector.kind === "managed" && connector.server === row.id);
      const state = link === undefined ? undefined : snapshot.states[link.id];
      const phase = state?.phase ?? (!row.enabled ? "disabled" : row.authorization === "required" ? "authorization-required" : "saved");
      const ready = link !== undefined && ["ready", "partial"].includes(phase);
      const selected = ready && manager.selectionConfirmed(scope.hostId, scope.scopeId, link.id);
      const busy = ["connecting", "preparing", "authorizing"].includes(phase);
      const status = selectionPending.has(itemId) ? intl.formatMessage({ id: "connector.status.processing", defaultMessage: "Processing…" })
        : selected ? intl.formatMessage({ id: "connector.status.selected", defaultMessage: "Used in conversation" })
        : ready ? intl.formatMessage({ id: "connector.status.use", defaultMessage: "Use in conversation" })
        : state?.authorizationUrl ? intl.formatMessage({ id: "connector.status.openAuthorization", defaultMessage: "Open authorization" })
        : phase === "authorization-required" ? intl.formatMessage({ id: "connector.status.configure", defaultMessage: "Configure" })
        : phase === "disabled" ? intl.formatMessage({ id: "connector.manage", defaultMessage: "Manage connectors" }) : phaseLabel(phase);
      const selecting = selectionPending.has(itemId);
      return { id: itemId, title: row.title, brandId: row.definitionId, phase, status, selected,
        switchState: ready ? selected : null, actionable: !selecting, busy: busy || selecting,
        error: selectionErrors.get(itemId) ?? state?.error ?? null } satisfies ConnectorQuickItem;
    });
    const nativeItems = snapshot.configuration.connectors.filter(row => row.hostId === scope.hostId && row.kind !== "managed").map(row => {
      const itemId = `native:${row.id}`, state = snapshot.states[row.id], phase = state?.phase ?? "saved";
      const ready = ["ready", "partial"].includes(phase), selected = ready && manager.selectionConfirmed(scope.hostId, scope.scopeId, row.id);
      const busy = ["connecting", "preparing", "authorizing"].includes(phase);
      const status = selectionPending.has(itemId) ? intl.formatMessage({ id: "connector.status.processing", defaultMessage: "Processing…" })
        : selected ? intl.formatMessage({ id: "connector.status.selected", defaultMessage: "Used in conversation" })
        : ready ? intl.formatMessage({ id: "connector.status.use", defaultMessage: "Use in conversation" })
        : state?.authorizationUrl ? intl.formatMessage({ id: "connector.status.openAuthorization", defaultMessage: "Open authorization" }) : phaseLabel(phase);
      const selecting = selectionPending.has(itemId);
      return { id: itemId, title: row.title, brandId: row.server, phase, status, selected,
        switchState: ready ? selected : null, actionable: !selecting, busy: busy || selecting,
        error: selectionErrors.get(itemId) ?? state?.error ?? null } satisfies ConnectorQuickItem;
    });
    return [...managedItems, ...nativeItems];
  }, [intl, managed.data?.instances, manager, scope.hostId, scope.scopeId, selectionErrors, selectionPending, snapshot.configuration.connectors, snapshot.states]);

  const selectConnector = useCallback(async (itemKey: string, connectorId: string, enabled: boolean) => {
    setSelectionPending(previous => new Set([...previous, itemKey]));
    setSelectionErrors(previous => { const next = new Map(previous); next.delete(itemKey); return next; });
    try { await manager.select(scope.hostId, scope.scopeId, connectorId, enabled); }
    catch (error) { setSelectionErrors(previous => new Map(previous).set(itemKey, error instanceof Error ? error.message : String(error))); }
    finally { setSelectionPending(previous => { const next = new Set(previous); next.delete(itemKey); return next; }); }
  }, [manager, scope.hostId, scope.scopeId]);

  const connectAndSelect = useCallback((itemKey: string, connectorId: string) => {
    void manager.connect(connectorId, operationOwner).then(() => {
      const phase = manager.getSnapshot().states[connectorId]?.phase;
      if (["ready", "partial"].includes(phase ?? "")) void selectConnector(itemKey, connectorId, true);
    });
  }, [manager, operationOwner, selectConnector]);

  const onQuickAction = useCallback((item: ConnectorQuickItem) => {
    if (item.id.startsWith("managed:")) {
      const instanceId = item.id.slice("managed:".length);
      const row = manager.managed.snapshot(scope.hostId).data?.instances.find(candidate => candidate.id === instanceId);
      if (row === undefined) return;
      if (!row.enabled || row.authorization === "required") { onManage?.(); return; }
      const link = manager.getSnapshot().configuration.connectors.find(connector => connector.hostId === scope.hostId && connector.kind === "managed" && connector.server === row.id);
      if (link === undefined) {
        setSelectionPending(previous => new Set([...previous, item.id]));
        void manager.managed.link(scope.hostId, row).then(id => connectAndSelect(item.id, id), error => {
          setSelectionErrors(previous => new Map(previous).set(item.id, error instanceof Error ? error.message : String(error)));
        }).finally(() => setSelectionPending(previous => { const next = new Set(previous); next.delete(item.id); return next; }));
        return;
      }
      const state = manager.getSnapshot().states[link.id];
      if (state?.authorizationUrl) { window.open(state.authorizationUrl, "_blank", "noopener,noreferrer"); return; }
      if (["connecting", "preparing", "authorizing"].includes(state?.phase ?? "")) { manager.cancel(link.id); return; }
      if (["ready", "partial"].includes(state?.phase ?? "")) { void selectConnector(item.id, link.id, !item.selected); return; }
      connectAndSelect(item.id, link.id);
      return;
    }
    const connectorId = item.id.slice("native:".length), state = manager.getSnapshot().states[connectorId];
    if (state?.authorizationUrl) { window.open(state.authorizationUrl, "_blank", "noopener,noreferrer"); return; }
    if (["connecting", "preparing", "authorizing"].includes(state?.phase ?? "")) { manager.cancel(connectorId); return; }
    if (["ready", "partial"].includes(state?.phase ?? "")) { void selectConnector(item.id, connectorId, !item.selected); return; }
    connectAndSelect(item.id, connectorId);
  }, [connectAndSelect, manager, onManage, scope.hostId, selectConnector]);

  const requests: ModalRequest[] = [];
  const approval = approvalsSnapshot[0];
  if (approval) requests.push({ id: approval.id, label: "确认连接器写操作", layer: "confirmation", size: "wide", appearance: "utility",
    onDismiss: () => approvals.respond(approval.id, false), confirmation: { confirmLabel: "仅允许这一次", cancelLabel: "拒绝", onConfirm: () => approvals.respond(approval.id, true) },
    content: <section className="connector-panel"><h2>允许这次写操作？</h2><p>{approval.connectorTitle} · {approval.tool}</p><p>{approval.description}</p>
      <p className="connector-panel__meta">设备：{approval.hostId}<br />会话：{approval.threadId}</p><pre aria-label="待执行参数">{approval.argumentsPreview}</pre><p>仅允许本次操作，之后的写入仍需确认。</p></section> });
  const activeItems = quickItems.filter(item => item.selected);
  return {
    requests,
    addMenuContent: (closeMenu: () => void) => <ConnectorAddMenuItem items={quickItems} onAction={onQuickAction} onManage={onManage} portalContainer={portalContainer} onAfterAction={closeMenu} />,
    launcher: <ConnectorStatusChip activeItems={activeItems} items={quickItems} onAction={onQuickAction} onManage={onManage} portalContainer={portalContainer} />,
  };
}
