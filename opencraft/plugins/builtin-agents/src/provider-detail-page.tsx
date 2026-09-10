import { Settings2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RuntimeDiscoveredModelView, RuntimeOpenAIProtocol, RuntimeProviderView } from "@opencraft/appserver-protocol";
import {
  SettingsButton, SettingsNotice, SettingsRow, SettingsSelect, SettingsSwitch, SettingsTextInput, SettingsActions,
} from "@opencraft/extension-react";
import type { LocalAgentSettingsService, LocalAgentSettingsSnapshot, SaveRuntimeProviderInput, ProviderEditState } from "./local-agent-settings-service";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function revision(snapshot: LocalAgentSettingsSnapshot, provider: RuntimeProviderView) {
  return snapshot.settings?.namespaces.find((entry) => entry.ns === provider.settingsNs)?.revision ?? -1;
}


/** Independent detail page: its only address is providerId, never list selection. */
export function ProviderDetailPage({ service, providerId, onDirty, onPending }: {
  service: LocalAgentSettingsService; providerId: string;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void;
}) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const provider = snapshot.providers?.providers.find(entry => entry.provider === providerId);
  if (!provider) return <SettingsNotice>This model service is no longer available.</SettingsNotice>;
  return <>{snapshot.error ? <SettingsNotice tone="error">{snapshot.error}</SettingsNotice> : null}<ProviderEditor service={service} snapshot={snapshot} provider={provider} onDirty={onDirty} onPending={onPending} /></>;
}

function ProviderEditor({ service, snapshot, provider, onDirty, onPending }: {
  service: LocalAgentSettingsService; snapshot: LocalAgentSettingsSnapshot; provider: RuntimeProviderView;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void;
}) {
  const initial = () => service.providerConfiguration(provider);
  const editor = service.editor(provider);
  const { draft, baseRevision, dirty, auth, apiKey, allowEndpointChange } = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  const setter = <K extends keyof ProviderEditState,>(key: K) => (value: ProviderEditState[K] | ((previous: ProviderEditState[K]) => ProviderEditState[K])) => editor.set(key, value);
  const setDraft = setter("draft"), setBaseRevision = setter("baseRevision"), setDirty = setter("dirty");
  const setAuth = setter("auth"), setApiKey = setter("apiKey"), setAllowEndpointChange = setter("allowEndpointChange");
  const [credentialSet, setCredentialSet] = useState<boolean | null>(null);
  const [manage, setManage] = useState(false);
  const [modelId, setModelId] = useState("");
  const [candidates, setCandidates] = useState<readonly RuntimeDiscoveredModelView[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRevision = revision(snapshot, provider);
  const conflict = dirty && baseRevision !== latestRevision;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (dirty) return;
    setDraft(initial()); setBaseRevision(latestRevision); setAuth("keep"); setApiKey(""); setAllowEndpointChange(false);
  }, [latestRevision, dirty]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    let current = true;
    void service.describeCredential(draft.credentialRef).then((value) => { if (current) setCredentialSet(value?.configured ?? false); }, () => { if (current) setCredentialSet(null); });
    return () => { current = false; };
  }, [draft.credentialRef, latestRevision, service]);
  const change = (next: Partial<typeof draft>) => { setDraft((value) => ({ ...value, ...next })); setDirty(true); setMessage(null); };
  const run = async (action: () => Promise<void>) => {
    setPending(true); onPending(true); setError(null); setMessage(null);
    try { await action(); } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { if (alive.current) setPending(false); onPending(false); }
  };
  const input = (): SaveRuntimeProviderInput => ({
    baseURL: draft.baseURL,
    credential: auth === "replace" ? { kind: "replace", value: apiKey } : auth === "reference"
      ? { kind: "reference", ref: draft.credentialRef } : { kind: "keep", allowEndpointChange },
    ...(provider.configuration?.modelDeclarations ? { displayName: draft.displayName, models: draft.models, ...(draft.api ? { api: draft.api } : {}) } : {}),
  });
  const effectiveModels = snapshot.models?.groups.find((group) => group.id === provider.provider)?.models ?? [];
  const combined = new Map(effectiveModels.map((model) => [model.id, model]));
  for (const model of draft.models) if (!combined.has(model.id)) combined.set(model.id, { id: model.id, name: model.name ?? model.id });
  const defaults = record(snapshot.settings?.namespaces.find((entry) => entry.ns === "agent-default-model")?.value);
  const isDefault = (id: string) => defaults.provider === provider.provider && defaults.model === id;
  const editable = snapshot.settings?.writable === true && !pending;
  const oauthOnly = provider.provider === "openai-codex";
  const addModel = (model: RuntimeDiscoveredModelView) => {
    if (!draft.models.some((entry) => entry.id === model.id)) change({ models: [...draft.models, model] });
  };
  return <div className="provider-settings__editor">
    <header className="provider-settings__header">
      <div><h2 id="settings-content-title">{provider.displayName}</h2><p>{provider.declared ? "Custom model service" : "Built-in model service"}</p></div>
      {provider.configuration?.canToggle ? <div className="provider-settings__toggle">
        <span>{provider.enabled ? "Enabled" : "Disabled"}</span>
        <SettingsSwitch label="Enable provider" checked={provider.enabled === true} disabled={!editable || dirty} onCheckedChange={(enabled) => {
          void run(async () => {
            await service.setEnabled(provider, enabled, latestRevision);
            setMessage(enabled ? "Provider enabled." : "Provider disabled. Configuration and credentials are retained.");
          });
        }} />
      </div> : null}
    </header>
    {provider.enabled && !provider.active ? <SettingsNotice tone="error">This service could not be loaded. Check its configuration.</SettingsNotice> : null}
    {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
    {message ? <SettingsNotice>{message}</SettingsNotice> : null}
    {conflict ? <SettingsNotice tone="error">This provider was changed elsewhere. Your draft is retained.<SettingsButton onClick={() => { setDirty(false); setError(null); }}>Discard draft and reload</SettingsButton></SettingsNotice> : null}
    {oauthOnly ? <SettingsNotice>Interactive OAuth sign-in is not connected in this settings page. API keys cannot activate this provider.</SettingsNotice> : <>
    <section className="provider-settings__section">
      <h3>Connection</h3>
      {provider.configuration?.apis.length ? <SettingsRow label="API protocol" htmlFor="provider-protocol"><SettingsSelect id="provider-protocol" value={draft.api ?? ""} disabled={!editable} onChange={(event) => change({ api: event.target.value ? event.target.value as RuntimeOpenAIProtocol : undefined })}>
        <option value="" disabled={!!draft.api}>Adapter default</option>{provider.configuration.apis.map((api) => <option key={api} value={api}>{api === "openai-completions" ? "Chat Completions" : "Responses"}</option>)}
      </SettingsSelect></SettingsRow> : null}
      <SettingsRow label="Base URL" htmlFor="provider-url"><SettingsTextInput id="provider-url" value={draft.baseURL} disabled={!editable} placeholder="Use provider default" onChange={(event) => { change({ baseURL: event.target.value }); setAllowEndpointChange(false); setCandidates([]); }} /></SettingsRow>
      <SettingsRow label="Authentication"><div className="provider-settings__auth">
        {auth === "replace" ? <SettingsTextInput aria-label="New API key" type="password" autoComplete="new-password" value={apiKey} disabled={!editable} onChange={(event) => { setApiKey(event.target.value); setDirty(true); }} /> : <span className="provider-settings__muted">{credentialSet === null ? "Checking API key…" : credentialSet ? "••••••••••••" : "No API key added"}</span>}
        <SettingsButton disabled={!editable} onClick={() => { setAuth(auth === "replace" ? "keep" : "replace"); setApiKey(""); setDirty(true); }}>{auth === "replace" ? "Cancel key change" : credentialSet ? "Replace key" : "Add API key"}</SettingsButton>
      </div></SettingsRow>
      {draft.baseURL !== initial().baseURL && auth === "keep" ? <label className="provider-settings__confirmation"><input type="checkbox" checked={allowEndpointChange} disabled={!editable} onChange={(event) => setAllowEndpointChange(event.target.checked)} />Allow the new endpoint to receive this connection’s existing credential</label> : null}
    </section>
    <section className="provider-settings__section">
      <div className="provider-settings__section-heading"><h3>Models <span>{combined.size}</span></h3><SettingsButton disabled={!editable} onClick={() => setManage(!manage)}><Settings2 size={14} />{manage ? "Done" : "Manage models"}</SettingsButton></div>
      {[...combined.values()].map((model) => {
        const persisted = effectiveModels.some(entry => entry.id === model.id);
        return <div className="provider-settings__model" key={model.id}><div><strong>{model.name}</strong>{model.name !== model.id ? <small>{model.id}</small> : null}</div>{isDefault(model.id) ? <span className="provider-settings__badge">Default</span> : null}
          <div className="provider-settings__model-actions">
            {model.source === "custom" ? <SettingsButton variant="ghost" aria-label={`Delete ${model.name}`} disabled={!editable || dirty || isDefault(model.id)} onClick={() => {
              if (window.confirm(`Delete ${model.name} from this provider? Existing conversation history will not be deleted.`)) void run(async () => { await service.changeModel(provider.provider, model.id); setMessage("Model configuration deleted."); });
            }}><Trash2 size={14} /></SettingsButton> : null}
            {model.enabled === false ? <span className="provider-settings__muted">Disabled</span> : null}
            {persisted ? <SettingsSwitch label={`Enable ${model.name}`} checked={model.enabled !== false} disabled={!editable || dirty || isDefault(model.id)} onCheckedChange={enabled => void run(async () => { await service.changeModel(provider.provider, model.id, enabled); setMessage(enabled ? "Model enabled." : "Model disabled. Existing conversations are unchanged."); })} /> : <SettingsButton variant="ghost" aria-label={`Remove unsaved ${model.name}`} onClick={() => change({ models: draft.models.filter(entry => entry.id !== model.id) })}><Trash2 size={14} /></SettingsButton>}
          </div>
        </div>;
      })}
      {combined.size === 0 ? <p className="provider-settings__muted">No models configured. Add a model ID or browse available candidates.</p> : null}
      {manage ? <div className="provider-settings__manager">
        {provider.configuration?.modelDeclarations ? <div className="provider-settings__auth"><SettingsTextInput aria-label="Model ID" value={modelId} disabled={!editable} placeholder="Exact model ID" onChange={(event) => setModelId(event.target.value)} /><SettingsButton disabled={!editable || !modelId.trim()} onClick={() => { addModel({ id: modelId.trim() }); setModelId(""); }}>Add model</SettingsButton></div> : null}
        <SettingsActions><SettingsButton disabled={!editable} onClick={() => void run(async () => setCandidates(await service.discoverModels(provider, input(), "catalog")))}>Browse catalog</SettingsButton>
          <SettingsButton disabled={!editable || !draft.baseURL || !draft.api} onClick={() => void run(async () => {
            setCandidates(await service.discoverModels(provider, input(), "endpoint"));
            setMessage("Endpoint model list loaded. This does not verify inference.");
          })}>Discover endpoint models</SettingsButton></SettingsActions>
        <p className="provider-settings__muted">Discovery uses only a newly entered key. Save new models before enabling or deleting them. Built-in models can be disabled; custom models can also be deleted.</p>
        {candidates.map((model) => <div className="provider-settings__model" key={model.id}><div>{model.name ?? model.id}<small>Candidate</small></div><SettingsButton disabled={!editable || !provider.configuration?.modelDeclarations || draft.models.some((entry) => entry.id === model.id)} onClick={() => addModel(model)}>Add to draft</SettingsButton></div>)}
      </div> : null}
    </section>
    <details className="provider-settings__advanced"><summary>Advanced settings</summary>
      {provider.configuration?.modelDeclarations ? <SettingsRow label="Display name" htmlFor="provider-name"><SettingsTextInput id="provider-name" value={draft.displayName} disabled={!editable} onChange={(event) => change({ displayName: event.target.value })} /></SettingsRow> : null}
      <SettingsRow label="Credential reference" htmlFor="provider-ref"><SettingsTextInput id="provider-ref" value={draft.credentialRef} disabled={!editable} onChange={(event) => { change({ credentialRef: event.target.value }); setAuth("reference"); }} /></SettingsRow>
      <p className="provider-settings__muted">Connection ID: {provider.provider}. Keep endpoint prefixes such as /v1; do not append /chat/completions or /responses.</p>
      <p className="provider-settings__muted">{provider.configuration?.canToggle ? "User-managed connection" : "Runtime-managed connection"} · {provider.active ? "Registered" : "Not registered"}. Saving this connection does not change the default model.</p>
    </details>
    {dirty ? <footer className="provider-settings__savebar"><span>Unsaved changes</span><div>
      <SettingsButton disabled={pending} onClick={() => { setDirty(false); setError(null); }}>Cancel</SettingsButton>
      <SettingsButton variant="primary" disabled={!editable || !dirty || conflict} onClick={() => void run(async () => {
        await service.saveProvider(provider, input(), baseRevision); setDirty(false); setApiKey(""); setAuth("keep"); setMessage("Provider saved. Inference has not been verified.");
      })}>Save changes</SettingsButton>
    </div></footer> : null}
    </>}
  </div>;
}
