import { useEffect, useState, useSyncExternalStore } from "react";
import type { RuntimeProviderView } from "@opencraft/appserver-protocol";
import {
  SettingsActions, SettingsButton, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSection, SettingsSelect, SettingsTextInput,
} from "@opencraft/extension-react";
import type { LocalAgentSettingsService, LocalAgentSettingsSnapshot, SaveRuntimeProviderInput } from "./local-agent-settings-service";

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function revision(snapshot: LocalAgentSettingsSnapshot, provider: RuntimeProviderView) {
  return snapshot.settings?.namespaces.find((entry) => entry.ns === provider.settingsNs)?.revision ?? -1;
}


export function ProviderCreatePage({ service, onCreated, onCancel, onDirty, onPending }: {
  service: LocalAgentSettingsService; onCreated: (id: string) => void; onCancel: () => void;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void;
}) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const presets = snapshot.providers?.providers.filter(entry => !entry.configured && entry.configuration?.modelDeclarations && entry.provider !== "openai-codex") ?? [];
  const [template, setTemplate] = useState("");
  const [name, setName] = useState("");
  const [creationId, setCreationId] = useState(() => `custom-${crypto.randomUUID()}`);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => onPending(pending), [pending, onPending]);
  return <>{error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}<div className="provider-settings__editor">
        <SettingsPageHeader title="Add model service" description="Create a disabled connection, then configure authentication and models." />
        <SettingsSection title="Connection">
          <SettingsRow label="Template" htmlFor="provider-template"><SettingsSelect id="provider-template" value={template} disabled={pending} onChange={(event) => { setTemplate(event.target.value); setName(presets.find((entry) => entry.provider === event.target.value)?.displayName ?? ""); }}>
            <option value="">Custom OpenAI-compatible</option>{presets.map((entry) => <option key={entry.provider} value={entry.provider}>{entry.displayName}</option>)}
          </SettingsSelect></SettingsRow>
          <SettingsRow label="Display name" htmlFor="new-provider-name"><SettingsTextInput id="new-provider-name" value={name} disabled={pending} placeholder="Company gateway" onChange={(event) => { setName(event.target.value); setDirty(true); }} /></SettingsRow>
          <SettingsActions><SettingsButton disabled={pending} onClick={onCancel}>Cancel</SettingsButton><SettingsButton variant="primary" disabled={pending || !name.trim()} onClick={async () => {
            setPending(true); setError(null);
            try {
              const preset = presets.find((entry) => entry.provider === template);
              const input: SaveRuntimeProviderInput = { displayName: name.trim(), baseURL: "", credential: { kind: "keep" }, enabled: false,
                // Installed adapters retain their own wire protocol and catalog.
                ...(preset ? {} : { api: "openai-completions", models: [] }),
              };
              const id = preset?.provider ?? creationId;
              if (preset) await service.saveProvider(preset, input, revision(snapshot, preset)); else await service.createProvider(id, input);
              setDirty(false); onCreated(id); setName(""); setTemplate("");
              setCreationId(`custom-${crypto.randomUUID()}`);
            } catch (error) { setError(errorText(error)); } finally { setPending(false); }
          }}>Create connection</SettingsButton></SettingsActions>
        </SettingsSection>
      </div></>;
}
