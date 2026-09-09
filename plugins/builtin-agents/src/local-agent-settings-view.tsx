import { Bot } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  SettingsActions, SettingsButton, SettingsGroup, AdaptivePanelView, SettingsNotice,
  SettingsPageHeader, SettingsRow, SettingsSection, SettingsSelect, SettingsSearchSelect,
  type ExtensionSettingsViewProps, type AdaptivePanelPage,
} from "@opencraft/extension-react";
import type { LocalAgentSettingsService } from "./local-agent-settings-service";
import { BrandIcon } from "./brand-icon";
import { ProviderListPage } from "./provider-list-page";
import { ProviderDetailPage } from "./provider-detail-page";
import { ProviderCreatePage } from "./provider-create-page";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function useSnapshot(service: LocalAgentSettingsService) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  useEffect(() => { void service.refresh(); }, [service]);
  return snapshot;
}

export function createLocalAgentDefaultModelView(service: LocalAgentSettingsService) {
  return function DefaultModelView(_props: ExtensionSettingsViewProps) {
    const snapshot = useSnapshot(service);
    const ns = snapshot.settings?.namespaces.find((entry) => entry.ns === "agent-default-model");
    const [selection, setSelection] = useState({ provider: "", model: "", effort: "" });
    const [dirty, setDirty] = useState(false);
    const [baseRevision, setBaseRevision] = useState(-1);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
      if (!ns || dirty) return;
      const value = record(ns.value);
      setSelection({ provider: String(value.provider ?? ""), model: String(value.model ?? ""), effort: String(value.reasoningEffort ?? "") });
      setBaseRevision(ns.revision);
    }, [ns?.revision, dirty]);
    const group = snapshot.models?.groups.find((entry) => entry.id === selection.provider);
    const model = group?.models.find((entry) => entry.id === selection.model);
    const invalidEffort = selection.effort !== "" && !!model && !model.reasoning?.efforts.some(entry => entry.id === selection.effort);
    const conflict = dirty && baseRevision !== ns?.revision;
    return <>
      <SettingsPageHeader title="Default model" description="Used for new conversations. Existing sessions keep their own selection." />
      {snapshot.error || error ? <SettingsNotice tone="error">{error ?? snapshot.error}</SettingsNotice> : null}
      {invalidEffort ? <SettingsNotice tone="error">The saved reasoning effort is not supported by this model. Clear it and save to use the model default.<SettingsButton onClick={() => { setSelection({ ...selection, effort: "" }); setDirty(true); }}>Use model default</SettingsButton></SettingsNotice> : null}
      {conflict ? <SettingsNotice tone="error">Settings changed elsewhere. Reload before saving.<SettingsButton onClick={() => setDirty(false)}>Reload</SettingsButton></SettingsNotice> : null}
      <SettingsSection title="Model">
        <SettingsGroup>
          <SettingsRow label="Model" htmlFor="local-agent-default-model">
            <SettingsSearchSelect id="local-agent-default-model" label="Models"
              value={selection.model ? JSON.stringify([selection.provider, selection.model]) : ""}
              disabled={pending || !snapshot.settings?.writable}
              groups={(snapshot.models?.groups ?? []).map(group => ({
                id: group.id, label: group.name, icon: <BrandIcon id={group.id} />,
                options: group.models.filter(model => model.enabled !== false && snapshot.providers?.providers.some(provider => provider.provider === group.id && provider.active)).map(model => ({
                  value: JSON.stringify([group.id, model.id]), label: model.name,
                  description: model.description ?? model.id, icon: <BrandIcon id={model.id} model />,
                  badge: model.reasoning ? "Reasoning" : undefined,
                })),
              }))}
              onChange={value => {
                const [providerId, modelId] = JSON.parse(value) as [string, string];
                const chosen = snapshot.models?.groups.find(g => g.id === providerId)?.models.find(m => m.id === modelId);
                if (!chosen) return;
                setSelection({ provider: providerId, model: modelId, effort: "" });
                setDirty(true);
              }} />
          </SettingsRow>
          <SettingsRow label="Reasoning" htmlFor="local-agent-default-reasoning"><SettingsSelect id="local-agent-default-reasoning" value={selection.effort} disabled={pending || !model?.reasoning} onChange={(event) => { setSelection({ ...selection, effort: event.target.value }); setDirty(true); }}>
            <option value="">Model default</option>
            {invalidEffort ? <option value={selection.effort} disabled>Unsupported: {selection.effort}</option> : null}
            {model?.reasoning?.efforts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </SettingsSelect></SettingsRow>
        </SettingsGroup>
        <SettingsActions><SettingsButton variant="primary" disabled={!dirty || conflict || invalidEffort || !model || pending || !snapshot.settings?.writable} onClick={async () => {
          setPending(true); setError(null);
          try { await service.saveDefaultModel(selection.provider, selection.model, selection.effort || undefined, baseRevision); setDirty(false); }
          catch (error) { setError(errorText(error)); } finally { setPending(false); }
        }}>Save default model</SettingsButton></SettingsActions>
      </SettingsSection>
      <SettingsSection title="Runtime" icon={<Bot size={16} />} description={snapshot.status?.displayName}>
        <p className="provider-settings__muted" data-selection="text">{snapshot.status?.cwd}</p>
      </SettingsSection>
    </>;
  };
}


/** Panel composition only. Geometry never changes selection or editor ownership. */
export function createLocalAgentSettingsView(service: LocalAgentSettingsService) {
  return function ProviderSettingsView(_props: ExtensionSettingsViewProps) {
    const snapshot = useSnapshot(service);
    const panel = useSyncExternalStore(service.panel.subscribe, service.panel.getSnapshot, service.panel.getSnapshot);
    const leaf = panel.secondaryId ?? "providers";
    const selected = leaf.startsWith("provider:") ? leaf.slice("provider:".length) : null;
    const firstProvider = snapshot.providers?.providers.find(entry => entry.configured)?.provider;
    useEffect(() => { if (firstProvider) service.panel.seed(`provider:${firstProvider}`); }, [service, firstProvider]);
    const providerId = selected ?? undefined;
    const [pending, setPending] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [editEpoch, setEditEpoch] = useState(0);
    const leave = () => {
      if (pending || (dirty && !window.confirm("Discard unsaved provider changes?"))) return false;
      if (dirty && providerId) { service.discardEditor(providerId); setEditEpoch(value => value + 1); }
      setDirty(false);
      return true;
    };
    const enter = (id: string) => service.panel.select(id);
    const pages: [AdaptivePanelPage, ...AdaptivePanelPage[]] = [{
      id: "providers", title: "Model services", minWidth: 220, layout: "collection" as const,
      content: <ProviderListPage service={service} selectedId={providerId} pending={pending}
        onSelect={id => { if (selected === id || leave()) enter(`provider:${id}`); }}
        onCreate={() => { if (leaf === "create-provider" || leave()) enter("create-provider"); }} />,
    }, ...(leaf === "create-provider" ? [{
      id: "create-provider", title: "Add model service", minWidth: 360,
      content: <ProviderCreatePage service={service} onDirty={setDirty} onPending={setPending}
        onCancel={() => { if (leave()) { service.panel.clear(); if (firstProvider) service.panel.seed(`provider:${firstProvider}`); } }}
        onCreated={id => { setDirty(false); setPending(false); enter(`provider:${id}`); }} />,
    }] : providerId ? [{
      id: `provider:${providerId}`, title: "Model service", minWidth: 360,
      content: <ProviderDetailPage key={`${providerId}:${editEpoch}`} service={service} providerId={providerId} onDirty={setDirty} onPending={setPending} />,
    }] : [])];
    return <AdaptivePanelView controller={service.panel} pages={pages} />;
  };
}
