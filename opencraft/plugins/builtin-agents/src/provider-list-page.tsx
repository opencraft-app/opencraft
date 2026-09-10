import { Plus, RefreshCw, Search } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { SettingsButton, SettingsNotice, SettingsTextInput } from "@opencraft/extension-react";
import type { LocalAgentSettingsService } from "./local-agent-settings-service";
import { BrandIcon } from "./brand-icon";

/** Independent collection page. It emits navigation intent, never renders a form. */
export function ProviderListPage({ service, selectedId, pending, onSelect, onCreate }: {
  service: LocalAgentSettingsService; selectedId?: string; pending: boolean;
  onSelect: (providerId: string) => void; onCreate: () => void;
}) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const [query, setQuery] = useState("");
  const providers = snapshot.providers?.providers.filter(entry => entry.configured) ?? [];
  return <div className="provider-list-page">
    <header className="provider-settings__list-heading"><h2>Model services</h2><SettingsButton aria-label="Add provider" disabled={pending || !snapshot.providers?.creation} onClick={onCreate}><Plus size={16} /></SettingsButton></header>
    <div className="provider-settings__search"><Search size={14} /><SettingsTextInput aria-label="Search providers" placeholder="Search connections…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {snapshot.error ? <SettingsNotice tone="error">{snapshot.error}</SettingsNotice> : null}
    <div className="provider-settings__connections">
      {providers.filter(entry => entry.displayName.toLowerCase().includes(query.toLowerCase())).map(entry => <button key={entry.provider} className="provider-settings__connection" aria-pressed={selectedId === entry.provider} disabled={pending} onClick={() => onSelect(entry.provider)}>
        <span className="provider-settings__avatar"><BrandIcon id={entry.provider} /></span><span><strong>{entry.displayName}</strong><small>{entry.enabled ? entry.active ? "Enabled" : "Needs attention" : "Disabled"}</small></span>
      </button>)}
      {providers.length === 0 ? <p className="provider-settings__muted">{snapshot.phase === "loading" ? "Loading services…" : "No configured connections"}</p> : null}
    </div>
    <footer className="provider-settings__list-footer"><SettingsButton variant="ghost" aria-label="Refresh providers" disabled={pending || snapshot.phase === "loading"} onClick={() => void service.refresh()}><RefreshCw size={14} /></SettingsButton></footer>
  </div>;
}
